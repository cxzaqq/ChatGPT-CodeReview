import { Context, Probot } from 'probot';
import { minimatch } from 'minimatch'

import { Chat } from './chat.js';
import log from 'loglevel';

const OPENAI_API_KEY = 'OPENAI_API_KEY';
const MAX_PATCH_COUNT = process.env.MAX_PATCH_LENGTH
  ? +process.env.MAX_PATCH_LENGTH
  : Infinity;

/**
 * patch에서 첫 번째 추가된 라인 위치를 반환
 * GitHub API의 position은 diff 내 상대 위치로,
 * patch에서 '+'로 시작하는 줄 중 첫 번째 위치(1부터 시작)를 반환
 * 못 찾으면 null 반환
 */
function getFirstAddedLinePosition(patch: string): number | null {
  const lines = patch.split('\n');
  let position = 0;
  for (const line of lines) {
    position++;
    // ' ' (context line), '+' (added line), '-' (removed line)
    // position counts every line in diff, but only added lines can be commented on
    // 따라서 '+'로 시작하는 첫 줄 위치 반환
    if (line.startsWith('+') && !line.startsWith('+++')) {
      return position;
    }
  }
  return null;
}

export const robot = (app: Probot) => {
  const loadChat = async (context: Context) => {
    if (process.env.OPENAI_API_KEY) {
      return new Chat(process.env.OPENAI_API_KEY);
    }

    const repo = context.repo();

    try {
      const { data } = (await context.octokit.request(
        'GET /repos/{owner}/{repo}/actions/variables/{name}',
        {
          owner: repo.owner,
          repo: repo.repo,
          name: OPENAI_API_KEY,
        }
      )) as any;

      if (!data?.value) {
        return null;
      }

      return new Chat(data.value);
    } catch {
      await context.octokit.issues.createComment({
        repo: repo.repo,
        owner: repo.owner,
        issue_number: context.pullRequest().pull_number,
        body: `Seems you are using me but didn't get OPENAI_API_KEY set in Variables/Secrets for this repo. You could follow [readme](https://github.com/anc95/ChatGPT-CodeReview) for more information.`,
      });
      return null;
    }
  };

  app.on(
    ['pull_request.opened', 'pull_request.synchronize'],
    async (context) => {
      const repo = context.repo();
      const chat = await loadChat(context);

      if (!chat) {
        log.info('Chat initialized failed');
        return 'no chat';
      }

      const pull_request = context.payload.pull_request;

      log.debug('pull_request:', pull_request);

      if (
        pull_request.state === 'closed' ||
        pull_request.locked
      ) {
        log.info('invalid event payload');
        return 'invalid event payload';
      }

      const target_label = process.env.TARGET_LABEL;
      if (
        target_label &&
        (!pull_request.labels?.length ||
          pull_request.labels.every((label) => label.name !== target_label))
      ) {
        log.info('no target label attached');
        return 'no target label attached';
      }

      const data = await context.octokit.repos.compareCommits({
        owner: repo.owner,
        repo: repo.repo,
        base: pull_request.base.sha,
        head: pull_request.head.sha,
      });

      let { files: changedFiles, commits } = data.data;

      log.debug("compareCommits, base:", pull_request.base.sha, "head:", pull_request.head.sha)
      log.debug("compareCommits.commits:", commits)
      log.debug("compareCommits.files", changedFiles)

      if (context.payload.action === 'synchronize' && commits.length >= 2) {
        const {
          data: { files },
        } = await context.octokit.repos.compareCommits({
          owner: repo.owner,
          repo: repo.repo,
          base: commits[commits.length - 2].sha,
          head: commits[commits.length - 1].sha,
        });

        changedFiles = files;
      }

      const ignoreList = (process.env.IGNORE || process.env.ignore || '')
          .split('\n')
          .filter((v) => v !== '');
      const ignorePatterns = (process.env.IGNORE_PATTERNS || '').split(',').filter((v) => Boolean(v.trim()));
      const includePatterns = (process.env.INCLUDE_PATTERNS || '').split(',').filter((v) => Boolean(v.trim()));

      log.debug('ignoreList:', ignoreList);
      log.debug('ignorePatterns:', ignorePatterns);
      log.debug('includePatterns:', includePatterns);

      changedFiles = changedFiles?.filter(
        (file) => {
          const url = new URL(file.contents_url)
          const pathname = decodeURIComponent(url.pathname)
          if (includePatterns.length) {
            return matchPatterns(includePatterns, pathname)
          }

          if (ignoreList.includes(file.filename)) {
            return false;
          }

          if (ignorePatterns.length) {
            return !matchPatterns(ignorePatterns, pathname)
          }

          return true
      })

      if (!changedFiles?.length) {
        log.info('no change found');
        return 'no change';
      }

      console.time('gpt cost');

      for (let i = 0; i < changedFiles.length; i++) {
        const file = changedFiles[i];
        const patch = file.patch || '';

        if (file.status !== 'modified' && file.status !== 'added') {
          continue;
        }

        if (!patch || patch.length > MAX_PATCH_COUNT) {
          log.info(
            `${file.filename} skipped caused by its diff is too large`
          );
          continue;
        }
        try {
          const res = await chat?.codeReview(patch);
          if (!res.lgtm && !!res.review_comment) {
            const position = getFirstAddedLinePosition(patch);
            try {
              if (position !== null) {
                // PR 리뷰 코멘트 시도
                await context.octokit.pulls.createReviewComment({
                  owner: repo.owner,
                  repo: repo.repo,
                  pull_number: pull_request.number,
                  body: res.review_comment,
                  commit_id: commits[commits.length - 1].sha, // 최신 커밋 SHA 사용
                  path: file.filename,
                  position,
                });
              } else {
                // position 못찾으면 일반 코멘트로 대체
                await context.octokit.issues.createComment({
                  owner: repo.owner,
                  repo: repo.repo,
                  issue_number: pull_request.number,
                  body: `🧾 줄을 찾을 수 없어 일반 코멘트로 남깁니다:\n\n${res.review_comment}`,
                });
              }
            } catch (err: any) {
              if (err.status === 422) {
                // 위치 찾기 실패 시 일반 코멘트로 대체
                await context.octokit.issues.createComment({
                  owner: repo.owner,
                  repo: repo.repo,
                  issue_number: pull_request.number,
                  body: `🧾 줄을 찾을 수 없어 일반 코멘트로 남깁니다:\n\n${res.review_comment}`,
                });
              } else {
                throw err;
              }
            }
          }
        } catch (e) {
          log.info(`review ${file.filename} failed`, e);
        }
      }

      console.timeEnd('gpt cost');
      log.info(
        'successfully reviewed',
        pull_request.html_url
      );

      return 'success';
    }
  );
};

const matchPatterns = (patterns: string[], path: string) => {
  return patterns.some((pattern) => {
    try {
      return minimatch(path, pattern.startsWith('/') ? "**" + pattern : pattern.startsWith("**") ? pattern : "**/" + pattern);
    } catch {
      try {
        return new RegExp(pattern).test(path);
      } catch (e) {
        return false;
      }
    }
  })
}

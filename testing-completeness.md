# apps-893 testing completeness

Reviewed 2026-10-10. Score is how complete the automated checks are for that repo, from 1 (nothing runs) to 10 (the important paths are checked without a live account).

`pdf-search-893` and `dliv-web` are private to this review. They are listed and not scored.

`video-convert-893` is scored from the branch that contains the 2026-10-10 suite (`./run_tests.sh`, 55 tests, mocked AWS).

## Scores

| Rank | Repo | Score | What exists |
|------|------|-------|-------------|
| 1 | `video-convert-893` | 7 | 55 tests in `./run_tests.sh`. GitHub Actions runs them on `dev`, `main`, and pull requests. Handlers stub DynamoDB, S3, and ECS. Disc detect, clip times, supersede, and ffmpeg argument lists are checked without ffmpeg. |
| 2 | `music-player-893` | 6 | About 34 Swift Testing cases in `MusicPlayerTests`, plus `./run_tests.sh` and `TESTING.md`. Models and the folder tree are covered. |
| 3 | `dropbox-893` | 4 | `backend/scripts/verify.sh` calls the deployed API: public `/albums`, and with a password `GET /files`, a reserved delete, and presigned upload and download. |
| 4 | `calendar-893` | 3 | `backend/scripts/verify.sh` calls the deployed API with a password: list, create, update, and delete one event. |
| 5 | `cognito-s3-stack-893` | 2 | `base/scripts/check-stack.sh` prints the deployed stack outputs. |
| 6 | `mileage-expense-tracker-893` | 2 | Xcode unit and UI test targets exist. The unit test is an empty `example()`. |
| 7 | `web-app-893` | 1 | No test files. `auth.js`, `privateFiles.js`, `calendar.js`, and `albumSlideShow.js` are unchecked. |
| — | `pdf-search-893` | — | Repository not readable from this review. |
| — | `dliv-web` | — | Repository not readable from this review. The family map describes it as the live fork of `web-app-893`. |

## How the scores were set

- **7–8.** A runner, CI, and tests for the decisions that name files or start jobs. Some AWS calls are stubbed. A real deploy or a real encode is still manual.
- **5–6.** Real unit tests and a local runner. CI is missing, or a large feature (playback, network, CarPlay) has no tests.
- **3–4.** A script checks a deployed API. It needs credentials and a stack, and it does not run on push.
- **1–2.** A status script, or test files that do not assert behavior.

## Top 5 gaps to close

1. **`web-app-893` has no tests for the clients that call the other APIs.** `auth.js`, `privateFiles.js`, `calendar.js`, and `albumSlideShow.js` are about 1,170 lines and have no runner. Add a `node --test` file that checks how each client builds URLs and handles a non-200 response, then run it from GitHub Actions. If `dliv-web` matches this tree, give it the same tests.

2. **`dropbox-893` and `calendar-893` only test a live stack.** `verify.sh` is useful after deploy and cannot run on a laptop without a pool, a password, and `*_outputs.json`. Pull the key and prefix rules out of `getPrivateFiles` and `calendarEvents` and run those with `node --test` on every push. Keep `verify.sh` for a manual check after `deploy.sh`.

3. **`mileage-expense-tracker-893` tests do not check a trip or an expense.** `MileageTracker893Tests.swift` is the Xcode template. The trips, expenses, vehicles, and OCR lambdas have no tests. Start with the pure totals and mileage math, then stub the handler `send` for create and list.

4. **`music-player-893` already has a suite that never runs in CI.** `./run_tests.sh` covers the track, cloud path, and folder-tree cases. Add a GitHub Actions job that runs that script. Playback, `CloudService`, and CarPlay stay manual until the protocols in `TESTING.md` exist.

5. **`video-convert-893` still skips presigned part URLs and several job routes.** `POST /uploads/parts` goes through the real AWS signer. `PATCH /jobs`, `DELETE /jobs`, `POST /uploads/complete`, `POST /uploads/abort`, and `POST /uploads/ready` are not in the stubbed suite. Stub `getSignedUrl` the same way `client.send` is stubbed, and add those five routes next to the existing handler tests.

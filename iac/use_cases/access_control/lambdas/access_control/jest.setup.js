const { applyHandlerTestEnv } = require('./test-env');
applyHandlerTestEnv();

// `tag-scan` writes one structured line per scan on purpose — it is what joins a
// CloudWatch REPORT to the row it wrote. In a test run that is 22 blocks of noise
// between the assertions, so it is silenced here rather than in each suite that
// happens to invoke a handler. It stays a mock, which is what lets the one test
// that cares assert on `console.info` directly; re-applied before every test so a
// `mockRestore` in one cannot un-silence the next. `warn` and `error` are left
// alone: a suite that provokes one is saying something.
beforeEach(() => {
  jest.spyOn(console, 'info').mockImplementation(() => {});
});

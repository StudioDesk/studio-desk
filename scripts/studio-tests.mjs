// Runs the project's tests on your edits, through the controller (v1.0 item 22). A code-editing employee
// runs it inside its attempt: the controller copies the story's source with the edits under changes/ applied
// and runs the test command where candidate tests run. Usage: node studio-tests.mjs [test files...]
import http from 'node:http';

const url = process.env.STUDIO_TESTS_URL,
  token = process.env.STUDIO_TESTS_TOKEN;
if (!url || !token) {
  console.error('Run this inside a Studio desk code-editing attempt; it has no test endpoint here.');
  process.exit(2);
}
const body = JSON.stringify({ files: process.argv.slice(2) });
const request = http.request(
  url,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'X-Studio-Attempt-Token': token,
    },
  },
  response => {
    let text = '';
    response.setEncoding('utf8');
    response.on('data', chunk => (text += chunk));
    response.on('end', () => {
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: text };
      }
      // Each answer sets the exit code and lets the program end on its own, rather than calling process.exit:
      // on macOS a write to a pipe finishes later, and exiting at once cut a long run's output short, its
      // summary included.
      if (response.statusCode !== 200) {
        console.error(data.error || `The controller answered ${response.statusCode}.`);
        process.exitCode = 2;
        return;
      }
      // The failed tests lead, each with its file and the start of its error, since the output tail may no longer
      // hold an early one; the controller lists at most 20, each already shortened. The summary stays last.
      const failed = Array.isArray(data.failedTests) ? data.failedTests : [];
      for (const test of failed)
        console.log(
          `Failed: ${test.name}${test.file ? ` (${test.file})` : ''}${test.error ? `\n  ${test.error}` : ''}`,
        );
      if (failed.length && data.totals?.fail > failed.length)
        console.log(`and ${data.totals.fail - failed.length} more failed`);
      if (failed.length) console.log('');
      if (data.output) process.stdout.write(data.output);
      if (data.errors) process.stderr.write(data.errors);
      console.log(`
${data.summary}`);
      process.exitCode = data.exitCode === 0 ? 0 : 1;
    });
  },
);
request.on('error', error => {
  console.error(`The controller could not be reached: ${error.message}`);
  process.exitCode = 2;
});
request.end(body);

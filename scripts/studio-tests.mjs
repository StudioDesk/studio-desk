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
      if (response.statusCode !== 200) {
        console.error(data.error || `The controller answered ${response.statusCode}.`);
        process.exit(2);
      }
      if (data.output) process.stdout.write(data.output);
      if (data.errors) process.stderr.write(data.errors);
      console.log(`
${data.summary}`);
      process.exit(data.exitCode === 0 ? 0 : 1);
    });
  },
);
request.on('error', error => {
  console.error(`The controller could not be reached: ${error.message}`);
  process.exit(2);
});
request.end(body);

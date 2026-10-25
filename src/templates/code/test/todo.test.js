const test = require('node:test');
const assert = require('node:assert/strict');
const { TodoList } = require('../src/todo.js');

test('adds items with their own ids', () => {
  const list = new TodoList();
  const milk = list.add('Buy milk');
  const call = list.add('  Call the plumber  ');
  assert.deepEqual(milk, { id: 1, title: 'Buy milk', done: false });
  assert.equal(call.id, 2);
  assert.equal(call.title, 'Call the plumber');
});

test('refuses an item without a title', () => {
  const list = new TodoList();
  assert.throws(() => list.add('   '), /needs a title/);
  assert.equal(list.items.length, 0);
});

test('marks an item done and lists what is left', () => {
  const list = new TodoList();
  const milk = list.add('Buy milk');
  list.add('Call the plumber');
  list.markDone(milk.id);
  assert.equal(milk.done, true);
  assert.deepEqual(
    list.remaining().map(item => item.title),
    ['Call the plumber'],
  );
});

test('refuses to mark an item that does not exist', () => {
  const list = new TodoList();
  assert.throws(() => list.markDone(7), /no item 7/);
});

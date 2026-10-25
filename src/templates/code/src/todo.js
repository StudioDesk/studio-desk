// A small to-do list: add items, mark one done, and list what is left.
class TodoList {
  constructor() {
    this.items = [];
    this.nextId = 1;
  }

  // Adds an item and returns it. A title is required.
  add(title) {
    const text = String(title ?? '').trim();
    if (!text) throw new Error('An item needs a title.');
    const item = { id: this.nextId++, title: text, done: false };
    this.items.push(item);
    return item;
  }

  // Marks the item with this id done and returns it.
  markDone(id) {
    const item = this.items.find(entry => entry.id === id);
    if (!item) throw new Error(`There is no item ${id}.`);
    item.done = true;
    return item;
  }

  // The items not done yet, in the order they were added.
  remaining() {
    return this.items.filter(item => !item.done);
  }
}

module.exports = { TodoList };

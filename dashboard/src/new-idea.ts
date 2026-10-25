// New idea from anywhere (the frame's button, the N key, the phone's middle tab): the frame opens Today and asks
// for the idea box; Today puts the cursor in it, or on a phone raises it as a sheet. A request made before Today
// shows waits for it.
let pending = false;
const listeners = new Set<() => void>();

export function requestNewIdea() {
  pending = true;
  for (const listener of listeners) listener();
}

// Today's side: called now for a waiting request, and for every later one.
export function onNewIdea(listener: () => void) {
  listeners.add(listener);
  if (pending) listener();
  return () => {
    listeners.delete(listener);
  };
}

export function newIdeaHandled() {
  pending = false;
}

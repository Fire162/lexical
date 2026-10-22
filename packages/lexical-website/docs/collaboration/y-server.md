---
sidebar_position: 3
---

# Server-side editing with `@lexical/y`

:::warning

`@lexical/y` is experimental. Its document layout and these APIs may change
without a migration.

:::

`@lexical/y/headless` runs Lexical edits on a stored Yjs 14 (`@y/y`) state on
a server, without a DOM. It binds a headless editor with the same binding as
the clients, so what the server writes is what a client would have written,
and it merges with the clients' concurrent edits like any other peer's. See
[Yjs 14 (`@lexical/y`)](./y.md) for the binding itself.

```ts
import {editYState, readYState, seedYState} from '@lexical/y/headless';
import {
  $createParagraphNode,
  $createTextNode,
  $getEditor,
  $getRoot,
} from 'lexical';

// The clients' extensions (or `nodes`): the server must register every node
// type the clients use.
const config = {extensions: [AppNodesExtension]};

// A new document. `$build` starts from an empty root.
const state = seedYState(config, () => {
  $getRoot().append($createParagraphNode().append($createTextNode('Hello')));
});

// One edit on the stored state.
const {update, state: next} = editYState(state, config, () => {
  $getRoot().append($createParagraphNode().append($createTextNode('More')));
});
// Send `update` to the connected clients and store `next`.

// Read the document at a state: its JSON, Markdown, plain text...
const json = readYState(next, config, () =>
  $getEditor().getEditorState().toJSON(),
);
```

## API

All of these take a config with the editor's `extensions` (or `nodes`), and
optionally:

- `root`: the shared root's name (default `'lexical-y'`);
- `clientIDRange`: the range of client ids the server writes with (see
  [yrs compatibility](#yrs-compatibility));
- `onWarn(message)`: the binding's and the editor's warnings (see
  [Warnings](#warnings));
- `selfCheck`: the binding's check of its own writes (default: on in
  development, off in production).

| Function | Returns |
| --- | --- |
| `seedYState(config, $build)` | The state of a new document holding what `$build` writes. |
| `editYState(state, config, $edit, options?)` | `{update, state, warnings}` after one edit. |
| `readYState(state, config, $read)` | What `$read` returns. Nothing is written. |
| `createHeadlessYEditor({...config, state})` | `{editor, doc, binding, warnings, dispose}` |

- **`seedYState`** writes the content the way a client's `initialize()`
  does: with a client id derived from the content, and outside any undo
  history. Seeding identical content twice gives the same bytes, so two
  servers that seed it at once write one copy. Content with random parts,
  such as the ids an extension draws for new blocks, is not identical: seed
  a document once.
- **`editYState`** runs `$edit` in one discrete editor update, then commits
  the updates it made listeners schedule (an extension giving new blocks
  ids), and returns the merged update of everything they wrote, or
  `update: null` when nothing changed, and `state` with the update merged
  in. The update includes what opening the document wrote (ids for blocks
  stored without one, repairs), because the edit may build on it. Options:
  - `allowedRoots`: the shared roots the update may write to (default: the
    layout root). An update that writes anywhere else, or that cannot be
    resolved, is refused.
  - `transact(doc)`: writes to other shared types of the same document, such
    as an activity log, in the same update. Their roots must be allowed.
  - `tag`: the tags of the editor update.

  An error thrown by `$edit` is rethrown, and nothing is returned.
- **`readYState`** discards what opening the document writes. See
  [Store what opening writes](#store-what-opening-writes).
- **`createHeadlessYEditor`** is for anything else. Its binding has
  collaborative undo off. Dispose of it with `dispose()` or `using`.

The helpers throw a `YHeadlessError` with a `code`:

- `'not-initialized'`: the state has no layout record yet; seed it first.
- `'read-only'`: the binding cannot write the document, for example because
  it uses a newer layout or a node type the config does not register. The
  message has the reason.
- `'foreign-roots'`: the update writes to a root that is not allowed.

### Warnings

The binding warns when a write failed and it rewrote the document from the
editor (the document is still right), when its self-check finds a write
that does not read back as the editor's content, and with the reason a
document is read only. The helpers pass every warning to `config.onWarn`
(default: `console.warn` outside production, nothing in production) and
return the edit's warnings in `warnings`. A warning never refuses an edit, in
any environment: refusing on a self-check mismatch would make development and
production behave differently. Log them, or alert on them.

An edit costs about as much as reading the document: about 300 ms in total
for a 10,000-paragraph document in Node 24 (development build), for an
update of about 70 bytes. The cost grows linearly with the document.

## Server patterns

### Store what opening writes

Opening a document can write to it: an extension gives ids to blocks stored
without one (`BlockIdExtension` does), or the binding repairs a shape left by
concurrent edits. `editYState` includes those writes in its update.
`readYState` reads them but does not store them, so a value assigned on open,
such as a block id, differs from one read to the next. Before reading such
values (to show a model the document's block ids, for example), store what
opening writes once:

```ts
const {update, state: repaired} = editYState(state, config, () => {});
if (update !== null) {
  // Store `repaired` and send `update` to the connected clients.
}
// Reads of `repaired` now agree.
```

### One writer per document

Run a document's server edits one after another, each on the latest stored
state, and store each update before the next edit starts. `editYState`
returns its input state with its own update merged in: two edits run at once
from the same stored state each return a state without the other's update,
and storing both loses one of them. (The updates themselves merge like any
two peers' updates. If edits must run in parallel, merge each `update` into
the latest stored state instead of storing the returned `state`.)

Clients' edits made while the server edits merge with the server's update in
either order, including typing in a block the server changes.

### Reject updates to old roots

A tab still running a client of an older layout (the Yjs 13 bindings'
`root` or `root-v2`) must not write into the document. Check every incoming
client update before applying it:

```ts
import {isUpdateForLayout} from '@lexical/y/server';

if (!isUpdateForLayout(update, {doc: serverDoc})) {
  // Refuse it (and close the connection, or ask the client to reload).
}
```

Pass the server's copy of the document so that items nested in existing
types and deletions resolve. `writeUpgradeNotice(doc)` writes a notice into
the old root that such tabs show. `@lexical/y/server` has no editor
dependencies.

For the server's own edits, `editYState` runs the same check with
`allowedRoots`.

### yrs compatibility

yrs (y-crdt) before 0.28 reads client ids as 32-bit numbers, while Yjs 14
draws 53-bit ones. When updates pass through such a relay or store (y-crdt
0.23, for example), keep every client id in 32 bits:

- on the server, `clientIDRange: 'uint32'` in the config;
- on the clients, `createYDoc({compat: 'yrs-0.23'})` for the document (and
  its awareness), or `clientIDRange: 'uint32'` on the binding.

Otherwise the relay stores the server's update under a truncated id, and a
client that received the update both directly and from the relay shows the
server's content twice. yrs 0.28 handles 53-bit ids.

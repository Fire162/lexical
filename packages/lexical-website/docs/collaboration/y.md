---
sidebar_position: 2
---

# Yjs 14 (`@lexical/y`)

:::warning Experimental
`@lexical/y` and its document layout are experimental. Every export is marked
`@experimental`, and `@y/y` (Yjs 14) is itself a release candidate. Pin both
versions, and read [Limits](#limits) before you build on it.
:::

`@lexical/y` is a collaboration binding for Lexical on Yjs 14 (the `@y/y`
package). It is separate from `@lexical/yjs`, the binding for Yjs 13 that the
[React guide](./react.md) uses. The two use different Yjs libraries and
different document layouts, and an application uses one or the other.

## When to use it

Use `@lexical/y` for a **new** collaborative editor that can run Yjs 14 on
every client and on its server:

- **Concurrent edits keep each other's text.** A paragraph, heading or list
  item is stored as its characters followed by a marker, and a link as a
  format over the characters it wraps. Splitting or joining a paragraph,
  changing its type, indenting a list item, or linking and unlinking text
  then keeps the characters, and merges with what a collaborator types at the
  same time. Bindings that store one shared element per node turn these
  edits into a delete and a re-insert, which can lose the collaborator's
  text.
- **Smaller documents.** Enter, Backspace, heading and list changes write
  only a marker or its attributes. In our measurements a session of 10,000
  edits takes about 210 KB, against 2.8 MB with the default layout of
  `@lexical/yjs`.
- **No React or DOM requirement.** The binding is a Lexical extension, so it
  works with any framework, in a headless editor or on a server.

Stay on `@lexical/yjs` when you have documents stored in its layouts (there is
no in-place migration yet, see [Upgrading](#upgrading-from-lexicalyjs)), when
your server or other clients cannot move to Yjs 14, or when you need the
`LexicalCollaborationPlugin` React API.

## Install

```bash
npm i @lexical/y @lexical/extension lexical @y/y@14.0.0-rc.28
```

`@y/y` is a peer dependency, pinned to the release candidate `@lexical/y` is
tested with. npm's `latest` tag points at an older release candidate, so name
the version. The type declarations that `@y/y` ships do not type-check on
their own (an upstream issue): if you run `tsc`, set `skipLibCheck: true`.
`@lexical/y`'s own declarations are clean.

## Set up an editor

`YCollabExtension` connects an editor to a Yjs document. It also provides
collaborative undo (`UNDO_COMMAND` and `REDO_COMMAND` undo only this client's
changes), so leave out `HistoryExtension`: the two conflict. Any Yjs 14
provider can carry the document; this example uses `@y/websocket`.

```ts
import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {ListExtension} from '@lexical/list';
import {RichTextExtension} from '@lexical/rich-text';
import {YCollabExtension} from '@lexical/y';
import {WebsocketProvider} from '@y/websocket';
import * as Y from '@y/y';
import {configExtension, defineExtension} from 'lexical';

const doc = new Y.Doc();

const editor = buildEditorFromExtensions(
  defineExtension({
    dependencies: [
      RichTextExtension,
      ListExtension,
      configExtension(YCollabExtension, {doc}),
    ],
    name: 'my-app/editor',
  }),
);
editor.setRootElement(document.getElementById('editor'));

const {binding, status} = getExtensionDependencyFromEditor(
  editor,
  YCollabExtension,
).output;

const provider = new WebsocketProvider('wss://example.com', 'my-room', doc);
provider.once('sync', () => {
  // Writes the editor's content if the document is new; otherwise does
  // nothing and the editor shows the shared content.
  binding.initialize();
});
```

What happens:

- The editor stays **read only** until the document's layout record has been
  read. `status` is a signal: `'pending'`, then `'active'`, or `'readonly'`
  when the document was written by a newer layout version than this client
  knows.
- `binding.initialize()`, called after the provider's first sync, marks an
  empty document with the layout version and writes the editor's initial
  content. Two clients that initialize the same content at once write it
  once (the same JSON, NodeState included: see [Limits](#limits) for random
  block ids). It does nothing on a document that already has content, and it
  refuses a document whose `@lexical/yjs` roots hold content (see
  [Upgrading](#upgrading-from-lexicalyjs)).
- Pass `synced: true` instead when the document is already loaded (a
  headless writer, a converter, a test): the extension initializes as soon as
  it registers.
- Register the same node classes on every client. A client that meets a node
  type it does not register goes read only with a warning, so it never hides
  and later deletes content it cannot show.

The other options of `YCollabExtension` (also accepted by `YBinding`):

| Option | Default | |
| -- | -- | -- |
| `root` | `doc.get('lexical-y')` | The shared root to bind. |
| `captureTimeout` | `500` | Undo capture timeout in ms; `null` turns collaborative undo off. |
| `clientIDRange` | `'uint53'` | `'uint32'` for servers on yrs before 0.28, see [Servers](#servers). |
| `selfCheck`, `selfCheckSample` | on in development | Reads every local write back from Yjs and reports a mismatch through the editor's `onWarn`. Sample it in production if you turn it on. |
| `onWarn` | none | Warnings from the binding (a newer layout, an unknown node type, a recovered read or write). |
| `convert` | `false` | Initialize even when a `@lexical/yjs` root has content, for a converter. |

Without the extension API, `new YBinding(editor, doc, options)` does the same:
call `binding.start()` to connect it, `binding.initialize()` after the first
sync, and `binding.undo()` / `binding.redo()` for undo. `binding.getCursor()`
and `binding.$resolveCursor()` convert the selection to and from Yjs relative
positions, for an awareness-based cursor UI; the binding does not create or
render remote cursors itself.

`writeEditorToYDoc(editor, doc)` is the one-off writer: it writes an
editor's content into the empty `@lexical/y` root of a document without a
live binding. Use it to seed a new document on the server (from a template or
an import) and in converters; use `YCollabExtension` for a live, editable
document.

## How content is stored

The shared root is `doc.get('lexical-y')`, a new root name, so a client of an
older layout never edits it. How each node is stored comes from the `collab`
key of the node class's `$config`, described in
[Collaboration storage with `collab`](../serialization/serialization.md#collab):

- a line (`ParagraphNode`, `HeadingNode`, `QuoteNode`, `ListItemNode`) is its
  inline content followed by a marker that carries its type, fields and
  NodeState;
- a list is rebuilt from consecutive list items, which carry its type,
  `start` and their level;
- a link is a format over the characters it wraps;
- text formats, styles and NodeState are formats of the characters;
- every other node (tables, cells, decorators, custom elements) is a shared
  node with its JSON as attributes and, for an element, its children inside.

Custom nodes are synchronized through their `$config` serialization schema
and NodeState. A custom block of inline content can declare
`collab: {block: 'line'}` to get the same behaviour as a paragraph.

## Servers

Any Yjs 14 server or relay can host the documents, and `@lexical/y/server`
provides helpers that have no editor dependencies:

- `isUpdateForLayout(update, {doc})` returns whether an update writes only to
  the `@lexical/y` root. A server can reject updates from clients that still
  run an older layout, for example in a y-websocket or Hocuspocus hook. Pass
  the server's copy of the document so that items nested in existing types,
  and deletions, resolve.
- `inspectUpdateRoots(update, doc)` returns the root names an update writes
  to, and how many of its structs could not be resolved.
- `writeUpgradeNotice(doc, message)` writes a paragraph into the
  `@lexical/yjs` root, so that a tab still running the old client shows it
  instead of an empty document.

Servers built on **yrs before 0.28** (y-crdt) read client ids as 32-bit
numbers, while Yjs 14 draws 53-bit ones. With such a server, an author can
receive its own content back as another client's on reconnect (duplicating
it), or lose offline edits. yrs 0.28 and later handle 53-bit ids. For an older
server, keep client ids in 32 bits: create the document with
`createYDoc({compat: 'yrs-0.23'})`, and pass `clientIDRange: 'uint32'` to
`YCollabExtension` (also accepted by `YBinding` and `writeEditorToYDoc`).
Create the awareness and the provider from that document, because an
awareness takes the document's client id when it is created.

## Limits

These are the known behaviours of concurrent edits that do not merge as a
user might expect. Every client still converges to the same document.

- **Moves.** Moving a block is a delete and a re-insert, so text a
  collaborator types into the moved block at the same time is lost or lands
  next to its old position. Two peers moving the same blocks at once can
  duplicate one. Lexical operations that move content (turning a paragraph
  into a list inside a container, indenting list items that hold blocks)
  behave the same way.
- **Delete wins.** Text typed into a container that a peer deletes at the
  same time is deleted with it. This includes a paragraph held inside a list
  item that a peer joins away with Backspace.
- **Last writer wins** for the fields of one link (URL and target merge as a
  whole) and for a field of one line.
- **Mark nodes.** `MarkNode` is an element with its own content, so wrapping a
  range moves the text into it, and concurrent typing in that range stays
  outside. Store comments as NodeState instead (`MarkStateExtension`).
- **Set-valued NodeState** (`createState(key, {collab: 'set'})`, used by
  `MarkStateExtension` for its mark ids) is stored as one value per text run
  for now: two collaborators adding comments to the same words at the same
  time keep one writer's set of ids. Every client converges and nothing
  throws; storing one entry per id is planned before `@lexical/y` is first
  released.
- **Not synchronized:** named slots, nested editor instances (their JSON
  snapshots are), and properties a node class keeps outside its `$config`
  schema and NodeState (the binding warns).
- **Repairs.** Concurrent edits can leave shapes Lexical would normalize (a
  ragged table after a row insert and a column insert, two equal lists side
  by side). Every client that sees one repairs it the same way. Text typed
  into the list being merged away before the merge reaches its author is
  lost.
- **Initial content with random values.** Two clients that initialize an
  empty document at once write it once only when their content is identical.
  An extension that gives every new block a random id makes it differ, so
  the initial content shows twice. Seed new documents on the server with
  `writeEditorToYDoc`, or give the initial blocks fixed ids.
- **Undo** keeps a container whole once another client has put content in
  it.
- **Large lists.** A structural edit in a list costs time proportional to
  the list on every client (regrouping and renumbering): about four times
  the default `@lexical/yjs` layout at 10,000 items.
- **Yjs internals.** The binding uses internals of `@y/y`, which is why it is
  pinned to a tested release candidate.

The [package README](https://github.com/facebook/lexical/tree/main/packages/lexical-y#limits)
lists every limit in detail.

## Upgrading from `@lexical/yjs`

There is no in-place migration yet. `@lexical/y` uses a different root and a
different layout, and `initialize()` refuses a document whose `@lexical/yjs`
roots (`root` or `root-v2`) hold content, so an old document is never
silently shown as empty or overwritten.

Until a converter ships:

- Start new documents on `@lexical/y`, and keep existing ones on
  `@lexical/yjs`. Choose the binding per document, and upgrade every client
  that opens a document at the same time.
- To move an existing document yourself, load it into an editor with
  `@lexical/yjs` (from a Yjs 13 copy of the document), then call
  `writeEditorToYDoc(editor, doc)` on the Yjs 14 document. It writes the
  `@lexical/y` root next to the old one, and refuses a root that already has
  content. Concurrent edits from old clients made after the conversion
  are not carried over: reject them on the server with `isUpdateForLayout`,
  and write `writeUpgradeNotice` into the old root so stale tabs ask the user
  to reload.

`@lexical/y/migrate` is reserved for a converter from the `@lexical/yjs`
layouts.

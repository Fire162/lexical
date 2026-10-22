/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {ClientIDRange} from './ClientID';
import type {Doc, Node as YNode} from '@y/y';
import type {LexicalEditor} from 'lexical';

import invariant from '@lexical/internal/invariant';

import {YBinding} from './Binding';

/**
 * @experimental The one-off writer: write an editor's current document into
 * the empty layout root of `doc`, without a live binding. Use it to seed a new
 * document (on a server, from a template or an import) and in converters,
 * which write it next to an older layout's root in the same document. Throws
 * when the layout root is not empty. For a live, editable document use
 * `YCollabExtension` (or `YBinding`).
 */
export function writeEditorToYDoc(
  editor: LexicalEditor,
  doc: Doc,
  options: {root?: YNode; clientIDRange?: ClientIDRange} = {},
): void {
  const binding = new YBinding(editor, doc, {
    captureTimeout: null,
    clientIDRange: options.clientIDRange,
    convert: true,
    onWarn: message => {
      invariant(false, '%s', message);
    },
    root: options.root,
  });
  const stop = binding.start();
  try {
    invariant(
      binding.status === 'pending',
      '@lexical/y: the shared root is not empty',
    );
    binding.initialize();
  } finally {
    stop();
  }
}

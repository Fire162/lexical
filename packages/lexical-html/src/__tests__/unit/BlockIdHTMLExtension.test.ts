/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $defaultIsIdentifiedBlock,
  $getBlockId,
  BlockIdExtension,
  buildEditorFromExtensions,
  configExtension,
  getExtensionDependencyFromEditor,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {
  $generateDOMFromNodes,
  $generateHtmlFromNodes,
  type BlockIdHTMLConfig,
  BlockIdHTMLExtension,
  DOMImportExtension,
} from '@lexical/html';
import {$isListItemNode, ListExtension} from '@lexical/list';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getEditor,
  $getRoot,
  $isElementNode,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

function counter(prefix = 'b') {
  let n = 0;
  return () => `${prefix}${++n}`;
}

function build(
  options: {
    html?: false | Partial<BlockIdHTMLConfig>;
    nested?: boolean;
    prefix?: string;
  } = {},
): LexicalEditorWithDispose {
  return buildEditorFromExtensions({
    $initialEditorState: null,
    dependencies: [
      RichTextExtension,
      ListExtension,
      configExtension(BlockIdExtension, {
        generateId: counter(options.prefix),
        ...(options.nested
          ? {
              $isIdentifiedBlock: (node: LexicalNode) =>
                $defaultIsIdentifiedBlock(node) || $isListItemNode(node),
            }
          : {}),
      }),
      ...(options.html === false
        ? []
        : [configExtension(BlockIdHTMLExtension, options.html || {})]),
    ],
    name: '[block-id-html]',
  });
}

/**
 * Parses a fixed HTML fixture. Tests never build markup from strings they
 * did not write: documents that carry other input (an exported document, an
 * attribute value) are built with DOM APIs.
 */
function parseFixture(fixture: string): Document {
  return new DOMParser().parseFromString(fixture, 'text/html');
}

/** A document whose body holds one `<p>` per entry, built with DOM APIs. */
function paragraphsDocument(
  entries: {id: string | null; tag?: string; text: string}[],
): Document {
  const doc = document.implementation.createHTMLDocument('');
  for (const {id, tag = 'p', text} of entries) {
    const element = doc.createElement(tag);
    if (id !== null) {
      element.setAttribute('data-block-id', id);
    }
    element.textContent = text;
    doc.body.append(element);
  }
  return doc;
}

function append(editor: LexicalEditor, dom: Document): void {
  editor.update(
    () =>
      $getRoot().append(
        ...getExtensionDependencyFromEditor(
          $getEditor(),
          DOMImportExtension,
        ).output.$generateNodesFromDOM(dom),
      ),
    {discrete: true},
  );
}

/** The editor's content exported as a DOM document (no HTML string). */
function exportDocument(editor: LexicalEditor): Document {
  const doc = document.implementation.createHTMLDocument('');
  editor.read(() => $generateDOMFromNodes(doc.body, null, editor));
  return doc;
}

function exportHTML(editor: LexicalEditor): string {
  return editor.read(() => $generateHtmlFromNodes(editor));
}

function tree(editor: LexicalEditor): string[] {
  return editor.read(() => {
    const out: string[] = [];
    const walk = (node: LexicalNode) => {
      if ($isElementNode(node)) {
        if (node.getType() !== 'root') {
          out.push(`${node.getType()}:${$getBlockId(node)}`);
        }
        node.getChildren().forEach(walk);
      }
    };
    walk($getRoot());
    return out;
  });
}

describe('BlockIdHTMLExtension', () => {
  test('without it, HTML carries no ids', () => {
    using editor = build({html: false});
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('one')),
        );
      },
      {discrete: true},
    );
    expect(exportHTML(editor)).not.toContain('data-block-id');
  });

  test('exports data-block-id on identified blocks only', () => {
    using editor = build();
    append(
      editor,
      parseFixture('<h1>Title</h1><p>Text</p><ul><li>a</li><li>b</li></ul>'),
    );
    expect(tree(editor)).toEqual([
      'heading:b1',
      'paragraph:b2',
      'list:b3',
      'listitem:null',
      'listitem:null',
    ]);
    expect(exportHTML(editor)).toBe(
      [
        '<h1 data-block-id="b1"><span style="white-space: pre-wrap;">Title</span></h1>',
        '<p data-block-id="b2"><span style="white-space: pre-wrap;">Text</span></p>',
        '<ul data-block-id="b3">',
        '<li value="1"><span style="white-space: pre-wrap;">a</span></li>',
        '<li value="2"><span style="white-space: pre-wrap;">b</span></li>',
        '</ul>',
      ].join(''),
    );
  });

  test('nested predicate exports list item ids', () => {
    using editor = build({nested: true});
    append(editor, parseFixture('<ul><li>a</li><li>b</li></ul>'));
    expect(exportHTML(editor)).toMatch(
      /<ul[^>]* data-block-id="b1"><li[^>]* data-block-id="b2"[^>]*>.*<li[^>]* data-block-id="b3"/,
    );
  });

  test('round-trips ids through HTML', () => {
    using source = build({nested: true, prefix: 's'});
    append(
      source,
      parseFixture(
        '<h2>Title</h2><p>Text</p><ul><li>a</li></ul><blockquote>q</blockquote>',
      ),
    );
    const exported = exportDocument(source);
    expect(exported.querySelectorAll('[data-block-id]')).toHaveLength(5);
    using target = build({nested: true, prefix: 't'});
    append(target, exported);
    expect(tree(target)).toEqual(tree(source));
    expect(tree(target)).toEqual([
      'heading:s1',
      'paragraph:s2',
      'list:s3',
      'listitem:s4',
      'quote:s5',
    ]);
  });

  test('imported ids pass through the uniqueness rule', () => {
    using editor = build();
    append(editor, parseFixture('<p>existing</p>'));
    expect(tree(editor)).toEqual(['paragraph:b1']);
    append(
      editor,
      paragraphsDocument([
        {id: 'x', text: 'first x'},
        {id: 'x', text: 'second x'},
        {id: 'b1', text: 'clashes with the document'},
        {id: '', text: 'empty'},
        {id: 'z'.repeat(129), text: 'too long'},
        {id: 'kept', tag: 'h3', text: 'kept'},
      ]),
    );
    expect(tree(editor)).toEqual([
      'paragraph:b1',
      'paragraph:x',
      'paragraph:b2',
      'paragraph:b3',
      'paragraph:b4',
      'paragraph:b5',
      'heading:kept',
    ]);
  });

  test('import: false ignores the attribute; export: false omits it', () => {
    using editor = build({html: {export: false, import: false}});
    append(editor, parseFixture('<p data-block-id="from-html">a</p>'));
    expect(tree(editor)).toEqual(['paragraph:b1']);
    expect(exportHTML(editor)).not.toContain('data-block-id');
  });
});

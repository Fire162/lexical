/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getState,
  $setState,
  createState,
  type ElementNode,
  type LexicalNode,
  type StateCollabEncoding,
} from 'lexical';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  type Client,
  createTestConnection,
  testClientsForEquality,
  waitForReact,
} from '../utils';

const EMPTY: ReadonlySet<string> = new Set();

function createTagsState(collab: StateCollabEncoding) {
  return createState(`tags-${collab}`, {
    collab,
    isEqual: (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
      a.size === b.size && Array.from(a).every(tag => b.has(tag)),
    parse: (value: unknown): ReadonlySet<string> =>
      Array.isArray(value)
        ? new Set(value.filter(tag => typeof tag === 'string'))
        : EMPTY,
    unparse: (value: ReadonlySet<string>) => Array.from(value).sort(),
  });
}

const setTagsState = createTagsState('set');
const valueTagsState = createTagsState('value');

type TagsState = typeof setTagsState;

// Not a member of the set-valued `tags-set` state: `tags-value` is not set-valued
const separatorKeyState = createState('tags-value\u001fnote', {
  parse: (value: unknown) => (typeof value === 'string' ? value : ''),
});

function $addTag(node: LexicalNode, stateConfig: TagsState, tag: string) {
  $setState(node, stateConfig, prev => new Set([...prev, tag]));
}

function $removeTag(node: LexicalNode, stateConfig: TagsState, tag: string) {
  $setState(node, stateConfig, prev => {
    const next = new Set(prev);
    next.delete(tag);
    return next;
  });
}

function $paragraph(): ElementNode {
  return $getRoot().getFirstChildOrThrow<ElementNode>();
}

/** The paragraph, or its only TextNode */
type Target = 'element' | 'text';

function $target(target: Target): LexicalNode {
  const paragraph = $paragraph();
  return target === 'element' ? paragraph : paragraph.getFirstChildOrThrow();
}

function readTags(
  client: Client,
  stateConfig: TagsState,
  target: Target,
): string[] {
  return client
    .getEditor()
    .read(() => Array.from($getState($target(target), stateConfig)).sort());
}

describe('Collaboration with set-valued NodeState', () => {
  let container: null | HTMLDivElement = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.removeChild(container!);
    container = null;
  });

  async function setup(useCollabV2: boolean, stateConfig: TagsState) {
    const connector = createTestConnection(useCollabV2);
    const client1 = connector.createClient('1');
    const client2 = connector.createClient('2');
    client1.start(container!);
    client2.start(container!);
    await waitForReact(() => {
      client1.update(() => {
        const paragraph = $createParagraphNode().append(
          $createTextNode('Hello'),
        );
        $getRoot().clear().append(paragraph);
        $addTag(paragraph, stateConfig, 'shared');
        $addTag(paragraph.getFirstChildOrThrow(), stateConfig, 'shared');
      });
    });
    return {client1, client2};
  }

  describe.each([
    ['v1', false],
    ['v2', true],
  ])('%s', (_name, useCollabV2) => {
    describe.each([['element'], ['text']] as const)('on %s', target => {
      it('concurrent additions of different members merge', async () => {
        const {client1, client2} = await setup(useCollabV2, setTagsState);
        client1.disconnect();
        client2.disconnect();
        await waitForReact(() => {
          client1.update(() => $addTag($target(target), setTagsState, 'a'));
          client2.update(() => $addTag($target(target), setTagsState, 'b'));
        });
        await waitForReact(() => {
          client1.connect();
          client2.connect();
        });
        for (const client of [client1, client2]) {
          expect(readTags(client, setTagsState, target)).toEqual([
            'a',
            'b',
            'shared',
          ]);
        }
        testClientsForEquality([client1, client2]);
        client1.stop();
        client2.stop();
      });

      it('a removal and a concurrent addition both apply', async () => {
        const {client1, client2} = await setup(useCollabV2, setTagsState);
        client1.disconnect();
        client2.disconnect();
        await waitForReact(() => {
          client1.update(() =>
            $removeTag($target(target), setTagsState, 'shared'),
          );
          client2.update(() => $addTag($target(target), setTagsState, 'b'));
        });
        await waitForReact(() => {
          client1.connect();
          client2.connect();
        });
        for (const client of [client1, client2]) {
          expect(readTags(client, setTagsState, target)).toEqual(['b']);
        }
        testClientsForEquality([client1, client2]);
        client1.stop();
        client2.stop();
      });

      it('a value state whose key contains U+001F is synced as is', async () => {
        const {client1, client2} = await setup(useCollabV2, setTagsState);
        await waitForReact(() => {
          client1.update(() =>
            $setState($target(target), separatorKeyState, 'x'),
          );
        });
        for (const client of [client1, client2]) {
          expect(
            client
              .getEditor()
              .read(() => $getState($target(target), separatorKeyState)),
          ).toBe('x');
          expect(
            client
              .getEditor()
              .read(() => $getState($target(target), setTagsState).size),
          ).toBe(1);
        }
        testClientsForEquality([client1, client2]);
        client1.stop();
        client2.stop();
      });

      it("with collab: 'value' one peer's whole set wins", async () => {
        const {client1, client2} = await setup(useCollabV2, valueTagsState);
        client1.disconnect();
        client2.disconnect();
        await waitForReact(() => {
          client1.update(() => $addTag($target(target), valueTagsState, 'a'));
          client2.update(() => $addTag($target(target), valueTagsState, 'b'));
        });
        await waitForReact(() => {
          client1.connect();
          client2.connect();
        });
        const tags = readTags(client1, valueTagsState, target);
        expect([
          ['a', 'shared'],
          ['b', 'shared'],
        ]).toContainEqual(tags);
        expect(readTags(client2, valueTagsState, target)).toEqual(tags);
        client1.stop();
        client2.stop();
      });
    });
  });
});

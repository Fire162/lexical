/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {LexicalEditor} from 'lexical';

import {useEffect} from 'react';

import {useSettings} from '../context/SettingsContext';

export const COLLAB_V3_NESTED_EDITOR_NOTICE =
  'Collaboration v3 does not sync nested editors, so this text is read only';

/**
 * Collaboration v3 (`@lexical/y`) does not sync nested editors (image
 * captions, sticky notes): only the snapshot taken when their node is written
 * reaches other clients. Rather than let edits diverge silently, the nested
 * editor is read only in that mode. Returns whether it is.
 */
export function useCollabV3NestedEditor(nestedEditor: LexicalEditor): boolean {
  const {
    settings: {isCollab, isRichText, useCollabV3},
  } = useSettings();
  const isCollabV3 = isCollab && isRichText && useCollabV3;
  useEffect(() => {
    if (isCollabV3) {
      nestedEditor.setEditable(false);
    }
  }, [isCollabV3, nestedEditor]);
  return isCollabV3;
}

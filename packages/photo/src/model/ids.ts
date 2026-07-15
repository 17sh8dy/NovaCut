/**
 * Branded ID types + generators for the photo domain.
 *
 * Brands off core's `Brand` symbol so a LayerId can never be passed where a core ClipId is
 * expected, and vice versa — the two documents share machinery but never share identity.
 */

import { newId, type Brand } from '@opencut/core';

export type PhotoDocumentId = Brand<string, 'PhotoDocumentId'>;
export type LayerId = Brand<string, 'LayerId'>;

export const newPhotoDocumentId = () => newId<PhotoDocumentId>('pdoc');
export const newLayerId = () => newId<LayerId>('lyr');

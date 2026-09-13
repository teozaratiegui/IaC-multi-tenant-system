'use strict';

/**
 * What a tag record is, once it has been read out of storage.
 *
 *   { tagId, allowed, chatId, tagName, tagNameNormalized, ownerName, ownerLastName }
 *
 * Two shape decisions live here because both are invariants, not formatting.
 *
 * 1. `chatId` is the one spelling. The deployed code read three
 *    (`chatId`, `ownerChatId`, `notifyTo`), left over from an old migration.
 *    Three ways to write the same field is three ways for the index not to see
 *    it — and the index is now how every bot command resolves a tag.
 *
 * 2. A record that has a `chatId` must also have a `tagNameNormalized`. The
 *    chatId-index has that attribute as its range key, and DynamoDB simply
 *    leaves out of an index any item missing a key attribute: a tag bound to a
 *    chat without the normalised name would vanish from its owner's /status
 *    with nothing logged. `associationAttributes` is the only place an
 *    association is built, and it always produces both.
 */

/** A tag name is a public range key and a chat-scoped identifier; keep it short. */
const MAX_TAG_NAME_LENGTH = 64;

/** The GSI that answers "which tags belong to this chat?". */
const CHAT_ID_INDEX = 'chatId-index';

function normaliseTagName(tagName) {
  return String(tagName ?? '').trim().toLowerCase();
}

/**
 * The attributes an association writes, all of them, in one object.
 *
 * @returns {{chatId: string, tagName: string, tagNameNormalized: string,
 *            ownerName: string, ownerLastName: string}}
 * @throws when the result would be invisible in the chat index.
 */
function associationAttributes({ chatId, tagName, ownerName, ownerLastName }) {
  const chat = String(chatId ?? '').trim();
  const displayName = String(tagName ?? '').trim();
  const normalized = normaliseTagName(displayName);

  if (chat === '') throw new Error('An association needs a chatId');
  if (normalized === '') throw new Error('An association needs a tag name');
  if (displayName.length > MAX_TAG_NAME_LENGTH) {
    throw new Error(`A tag name must be at most ${MAX_TAG_NAME_LENGTH} characters`);
  }

  return {
    chatId: chat,
    tagName: displayName,
    tagNameNormalized: normalized,
    ownerName: String(ownerName ?? '').trim(),
    ownerLastName: String(ownerLastName ?? '').trim(),
  };
}

/**
 * Whether this record can be found through the chat index.
 *
 * A tag with neither attribute is correctly outside it: an auto-registered tag
 * belongs to no chat and must not appear in anyone's listing.
 */
function isVisibleInChatIndex(record) {
  return Boolean(record?.chatId) && Boolean(record?.tagNameNormalized);
}

function ownerFullName(record) {
  return [record?.ownerName, record?.ownerLastName].filter(Boolean).join(' ');
}

/** How a tag is named to a human: its name, or its raw id when it has none. */
function tagLabel(record) {
  return record?.tagName || record?.tagId || '';
}

module.exports = {
  CHAT_ID_INDEX,
  MAX_TAG_NAME_LENGTH,
  normaliseTagName,
  associationAttributes,
  isVisibleInChatIndex,
  ownerFullName,
  tagLabel,
};

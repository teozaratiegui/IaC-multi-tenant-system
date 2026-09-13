'use strict';

const {
  normaliseTagName,
  associationAttributes,
  isVisibleInChatIndex,
  ownerFullName,
  tagLabel,
  MAX_TAG_NAME_LENGTH,
} = require('./tag');

describe('normaliseTagName', () => {
  test('folds case and surrounding blanks, which is what makes names unique per chat', () => {
    expect(normaliseTagName('  Bici  ')).toBe('bici');
    expect(normaliseTagName('BICI')).toBe(normaliseTagName('bici'));
  });

  test('a name that is only blanks normalises to nothing', () => {
    expect(normaliseTagName('   ')).toBe('');
    expect(normaliseTagName(undefined)).toBe('');
    expect(normaliseTagName(null)).toBe('');
  });
});

describe('associationAttributes', () => {
  const input = {
    chatId: 12345,
    tagName: '  Bici  ',
    ownerName: 'Teo',
    ownerLastName: 'Zaratiegui',
  };

  test('chatId and tagNameNormalized are produced together, never separately', () => {
    // The GSI has tagNameNormalized as its range key, so an item with a chatId
    // and no normalised name simply does not appear in the index — /status would
    // stop listing it. Producing both here is how that invariant is kept.
    const attributes = associationAttributes(input);
    expect(attributes.chatId).toBe('12345');
    expect(attributes.tagNameNormalized).toBe('bici');
    expect(attributes.tagName).toBe('Bici');
  });

  test('the display name keeps its casing while the key does not', () => {
    const attributes = associationAttributes({ ...input, tagName: 'Bici De Teo' });
    expect(attributes.tagName).toBe('Bici De Teo');
    expect(attributes.tagNameNormalized).toBe('bici de teo');
  });

  test('refuses an association that would be invisible in the index', () => {
    expect(() => associationAttributes({ ...input, tagName: '   ' })).toThrow();
    expect(() => associationAttributes({ ...input, chatId: '' })).toThrow();
  });

  test('caps the name length, since it is a public range key', () => {
    const long = 'n'.repeat(MAX_TAG_NAME_LENGTH + 1);
    expect(() => associationAttributes({ ...input, tagName: long })).toThrow();
  });
});

describe('isVisibleInChatIndex', () => {
  test('the invariant: a record with a chat must carry its normalised name', () => {
    expect(isVisibleInChatIndex({ chatId: '1', tagNameNormalized: 'bici' })).toBe(true);
    expect(isVisibleInChatIndex({ chatId: '1', tagNameNormalized: '' })).toBe(false);
  });

  test('a tag that belongs to nobody is correctly outside the index', () => {
    // An auto-registered tag has neither attribute; it belongs to no chat and
    // must not show up in anyone's /status.
    expect(isVisibleInChatIndex({ chatId: '', tagNameNormalized: '' })).toBe(false);
  });
});

describe('presentation helpers', () => {
  test('the owner is the two names joined, and nothing when there are none', () => {
    expect(ownerFullName({ ownerName: 'Teo', ownerLastName: 'Zaratiegui' })).toBe('Teo Zaratiegui');
    expect(ownerFullName({ ownerName: 'Teo', ownerLastName: '' })).toBe('Teo');
    expect(ownerFullName({})).toBe('');
  });

  test('a tag is labelled by its name, falling back to its id', () => {
    expect(tagLabel({ tagId: 'E280', tagName: 'bici' })).toBe('bici');
    expect(tagLabel({ tagId: 'E280', tagName: '' })).toBe('E280');
  });
});

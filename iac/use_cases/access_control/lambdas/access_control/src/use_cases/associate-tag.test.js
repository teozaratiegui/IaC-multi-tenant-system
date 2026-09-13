'use strict';

const { AssociateTagUseCase } = require('./associate-tag');

const BOUND = {
  tagId: 'E280',
  allowed: true,
  chatId: '99',
  tagName: 'Bici',
  tagNameNormalized: 'bici',
  ownerName: 'Teo',
  ownerLastName: 'Zaratiegui',
};

const INPUT = {
  tag: 'E280',
  chatId: '99',
  tagName: 'Bici',
  ownerName: 'Teo',
  ownerLastName: 'Zaratiegui',
};

function makeRepository({ existing = null, associate = 'ok', afterwards = BOUND } = {}) {
  return {
    findByChatAndName: jest.fn().mockResolvedValue(existing),
    associate: jest.fn().mockResolvedValue(associate),
    findById: jest.fn().mockResolvedValue(afterwards),
  };
}

const run = (tagRepository, input = INPUT) =>
  new AssociateTagUseCase({ tagRepository }).execute(input);

describe('a successful association', () => {
  test('answers 200 with the record as it now stands', async () => {
    const result = await run(makeRepository());

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      tag: 'E280',
      tagName: 'Bici',
      chatId: '99',
      ownerName: 'Teo',
      ownerLastName: 'Zaratiegui',
    });
  });

  test('writes chatId and tagNameNormalized together — the index invariant', async () => {
    // The GSI range key is tagNameNormalized. An item with a chatId and no
    // normalised name is simply absent from the index, so its owner's /status
    // would stop listing it with nothing logged anywhere.
    const tagRepository = makeRepository();
    await run(tagRepository);

    expect(tagRepository.associate).toHaveBeenCalledTimes(1);
    expect(tagRepository.associate).toHaveBeenCalledWith({
      tagId: 'E280',
      chatId: '99',
      tagName: 'Bici',
      ownerName: 'Teo',
      ownerLastName: 'Zaratiegui',
    });
  });

  test('rebinding the same tag under the same name is not a duplicate', async () => {
    const tagRepository = makeRepository({ existing: BOUND });
    expect((await run(tagRepository)).status).toBe(200);
  });
});

describe('an association that cannot be made', () => {
  test('404 when the tag does not exist — no phantom tag is created', async () => {
    // A mistyped EPC has to fail. Creating the tag is the separate `provision`
    // operation, and it is deliberately not what this one falls back to.
    const result = await run(makeRepository({ associate: 'not_found' }));

    expect(result.status).toBe(404);
    expect(result.body.tag).toBe('E280');
  });

  test('409 when another tag in the chat already answers to that name', async () => {
    const tagRepository = makeRepository({ existing: { ...BOUND, tagId: 'OTHER' } });
    const result = await run(tagRepository);

    expect(result.status).toBe(409);
    expect(tagRepository.associate).not.toHaveBeenCalled();
  });

  test('the duplicate check is a one-item lookup, not a listing', async () => {
    const tagRepository = makeRepository();
    await run(tagRepository);

    expect(tagRepository.findByChatAndName).toHaveBeenCalledWith('99', 'Bici');
    expect(tagRepository.findByChat).toBeUndefined();
  });

  test('names that differ only in case or blanks collide', async () => {
    const tagRepository = makeRepository({ existing: { ...BOUND, tagId: 'OTHER' } });
    const result = await run(tagRepository, { ...INPUT, tagName: '  bici ' });
    expect(result.status).toBe(409);
  });

  test('400 when a required field is missing or blank', async () => {
    for (const field of ['tag', 'chatId', 'tagName']) {
      const result = await run(makeRepository(), { ...INPUT, [field]: '  ' });
      expect(result.status).toBe(400);
    }
  });

  test('400 for a name too long to be a range key', async () => {
    const result = await run(makeRepository(), { ...INPUT, tagName: 'n'.repeat(200) });
    expect(result.status).toBe(400);
  });
});

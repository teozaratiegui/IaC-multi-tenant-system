'use strict';

const { ProvisionTagUseCase } = require('./provision-tag');

const FIXED_NOW = new Date('2026-09-12T17:32:05.000Z');

function makeRepository(provision = 'created', record = { tagId: 'E280', allowed: true }) {
  return {
    provision: jest.fn().mockResolvedValue(provision),
    findById: jest.fn().mockResolvedValue(record),
    findByChatAndName: jest.fn().mockResolvedValue(null),
  };
}

const run = (tagRepository, input) =>
  new ProvisionTagUseCase({ tagRepository, now: () => FIXED_NOW }).execute(input);

describe('provisioning a tag', () => {
  test('201 with the tag created and allowed by default', async () => {
    // This is the answer to "how does a tag get into production?". Until now
    // the only thing that created tags was the auto-registration flag, which is
    // a development convenience and off in production by design.
    const tagRepository = makeRepository();
    const result = await run(tagRepository, { tag: 'E280' });

    expect(result.status).toBe(201);
    expect(tagRepository.provision).toHaveBeenCalledWith({
      tagId: 'E280',
      allowed: true,
      registeredAt: FIXED_NOW.toISOString(),
      association: undefined,
    });
  });

  test('a tag can be created already blocked', async () => {
    const tagRepository = makeRepository();
    await run(tagRepository, { tag: 'E280', allowed: false });
    expect(tagRepository.provision.mock.calls[0][0].allowed).toBe(false);
  });

  test('409 when the tag already exists — never a silent overwrite', async () => {
    const result = await run(makeRepository('exists'), { tag: 'E280' });
    expect(result.status).toBe(409);
  });

  test('400 when there is no tag to create', async () => {
    expect((await run(makeRepository(), { tag: '  ' })).status).toBe(400);
  });
});

describe('provisioning and binding in one call', () => {
  test('creates the tag with its owner attached, in a single write', async () => {
    // The real operator gesture: a new bike gets its tag and its owner at once.
    const tagRepository = makeRepository();
    const result = await run(tagRepository, {
      tag: 'E280',
      chatId: '99',
      tagName: ' Bici ',
      ownerName: 'Teo',
      ownerLastName: 'Zaratiegui',
    });

    expect(result.status).toBe(201);
    expect(tagRepository.provision).toHaveBeenCalledTimes(1);
    expect(tagRepository.provision.mock.calls[0][0].association).toEqual({
      chatId: '99',
      tagName: 'Bici',
      tagNameNormalized: 'bici',
      ownerName: 'Teo',
      ownerLastName: 'Zaratiegui',
    });
  });

  test('a half-given association is refused rather than written incomplete', async () => {
    // chatId without a name would create an item invisible in the chat index.
    const result = await run(makeRepository(), { tag: 'E280', chatId: '99' });
    expect(result.status).toBe(400);
  });

  test('409 when that chat already has a tag with the same name', async () => {
    // The regression this guards: `provision` conditions only on
    // attribute_not_exists(tagId), so without the check two different tags end
    // up sharing a (chatId, tagNameNormalized) pair — the full key of the chat
    // index. Every later /status, /lock and /unlock then resolves to whichever
    // of the two the query returns first, and the owner is told an access was
    // disabled while the other tag stays open.
    const tagRepository = makeRepository();
    tagRepository.findByChatAndName.mockResolvedValue({ tagId: 'OTHER', tagName: 'Bici' });

    const result = await run(tagRepository, { tag: 'E280', chatId: '99', tagName: 'bici' });

    expect(result.status).toBe(409);
    expect(result.body.tagName).toBe('bici');
    expect(tagRepository.provision).not.toHaveBeenCalled();
  });

  test('the name is matched case- and blank-insensitively, like the index key', async () => {
    const tagRepository = makeRepository();
    await run(tagRepository, { tag: 'E280', chatId: '99', tagName: ' Bici ' });
    expect(tagRepository.findByChatAndName).toHaveBeenCalledWith('99', 'Bici');
  });

  test('a tag with no association is never name-checked', async () => {
    // An auto-registered or bare tag belongs to no chat, so there is no name to
    // collide with and no reason to pay for the query.
    const tagRepository = makeRepository();
    await run(tagRepository, { tag: 'E280' });
    expect(tagRepository.findByChatAndName).not.toHaveBeenCalled();
  });
});

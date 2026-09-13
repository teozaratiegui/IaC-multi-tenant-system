'use strict';

const { RunBotCommandUseCase, parseCommand } = require('./run-bot-command');
const { createMessages } = require('../domain/messages');

const MESSAGES = createMessages({
  orgDisplayName: 'acme',
  locale: 'es-AR',
  timeZone: 'America/Argentina/Buenos_Aires',
});

const BICI = {
  tagId: 'E280',
  allowed: true,
  chatId: '99',
  tagName: 'bici',
  tagNameNormalized: 'bici',
  ownerName: 'Teo',
  ownerLastName: 'Zaratiegui',
};

function makeRepository({ byChat = [BICI], byName = BICI } = {}) {
  return {
    findByChat: jest.fn().mockResolvedValue(byChat),
    findByChatAndName: jest.fn().mockResolvedValue(byName),
    setAllowed: jest.fn().mockResolvedValue(true),
  };
}

const run = (tagRepository, text, from = '99') =>
  new RunBotCommandUseCase({ tagRepository, messages: MESSAGES }).execute({ from, text });

describe('parseCommand', () => {
  test('splits a command from its argument', () => {
    expect(parseCommand('/status bici')).toEqual({ command: 'status', arg: 'bici' });
    expect(parseCommand('  /LOCK  Bici de Teo ')).toEqual({
      command: 'lock',
      arg: 'Bici de Teo',
    });
  });

  test('plain text is not a command', () => {
    expect(parseCommand('hola')).toEqual({ command: '', arg: '' });
    expect(parseCommand('')).toEqual({ command: '', arg: '' });
    expect(parseCommand(undefined)).toEqual({ command: '', arg: '' });
  });
});

describe('/help and /start', () => {
  test('both list the commands, and neither touches storage', async () => {
    // /start is the first thing Telegram sends when a chat is opened. Without
    // it the bot answered "comando desconocido" to the very first contact.
    const tagRepository = makeRepository();

    for (const text of ['/help', '/start']) {
      const { replyText } = await run(tagRepository, text);
      expect(replyText).toContain('/status');
    }
    expect(tagRepository.findByChat).not.toHaveBeenCalled();
  });
});

describe('/status', () => {
  test('with no argument, lists every tag in the chat', async () => {
    const { replyText } = await run(makeRepository(), '/status');
    expect(replyText).toContain('• bici: desbloqueado (acceso habilitado)');
  });

  test('with a name, reads exactly one tag from the index', async () => {
    const tagRepository = makeRepository();
    const { replyText } = await run(tagRepository, '/status bici');

    expect(tagRepository.findByChatAndName).toHaveBeenCalledWith('99', 'bici');
    expect(tagRepository.findByChat).not.toHaveBeenCalled();
    expect(replyText).toContain('ID: E280');
    expect(replyText).toContain('Titular: Teo Zaratiegui');
  });

  test('a chat with nothing bound to it is told so', async () => {
    const { replyText } = await run(makeRepository({ byChat: [] }), '/status');
    expect(replyText).toContain('No hay ningún tag asociado a este chat');
  });

  test('a name nobody owns in a chat that does have tags says just that', async () => {
    const { replyText } = await run(makeRepository({ byName: null }), '/status auto');
    expect(replyText).toContain('"auto"');
  });

  test('a name asked for in an empty chat gets the friendlier message', async () => {
    const { replyText } = await run(
      makeRepository({ byChat: [], byName: null }),
      '/status auto',
    );
    expect(replyText).toContain('Contacte al administrador');
  });
});

describe('/lock and /unlock', () => {
  test('flip the flag on the named tag', async () => {
    const locking = makeRepository();
    await run(locking, '/lock bici');
    expect(locking.setAllowed).toHaveBeenCalledWith('E280', false);

    const unlocking = makeRepository();
    await run(unlocking, '/unlock bici');
    expect(unlocking.setAllowed).toHaveBeenCalledWith('E280', true);
  });

  test('warn that readers take up to five minutes to catch up', async () => {
    // The gateway caches the decision for 300 s and nothing invalidates it, so
    // without this the bot says "unlocked" and the door keeps refusing. Telling
    // the user is the honest half of finding G18.
    for (const command of ['/lock bici', '/unlock bici']) {
      const { replyText } = await run(makeRepository(), command);
      expect(replyText).toContain('5 minutos');
    }
  });

  test('without a name, say how to give one instead of guessing', async () => {
    const tagRepository = makeRepository();
    const { replyText } = await run(tagRepository, '/lock');

    expect(replyText).toContain('/lock');
    expect(tagRepository.setAllowed).not.toHaveBeenCalled();
  });

  test('a name nobody owns changes nothing', async () => {
    const tagRepository = makeRepository({ byName: null });
    const { replyText } = await run(tagRepository, '/lock auto');

    expect(tagRepository.setAllowed).not.toHaveBeenCalled();
    expect(replyText).toContain('"auto"');
  });

  test('a tag deleted between the lookup and the write does not claim success', async () => {
    const tagRepository = makeRepository();
    tagRepository.setAllowed.mockResolvedValue(false);
    const { replyText } = await run(tagRepository, '/lock bici');

    expect(replyText).not.toContain('quedó deshabilitado');
  });
});

describe('anything else', () => {
  test('an unknown command points at /help', async () => {
    const { replyText } = await run(makeRepository(), '/teleport');
    expect(replyText).toContain('/help');
  });

  test('plain conversation gets the same nudge', async () => {
    const { replyText } = await run(makeRepository(), 'hola, todo bien?');
    expect(replyText).toContain('/help');
  });
});

describe('the chat is the only authorisation there is', () => {
  test('every lookup is scoped to the sender, never to a tag id from the body', async () => {
    // Tags are resolved by name within the chat and never by id: that is what
    // stops one chat from naming another chat's tag. It is also why the GSI has
    // to exist.
    const tagRepository = makeRepository();
    await run(tagRepository, '/lock bici', '12345');

    expect(tagRepository.findByChatAndName).toHaveBeenCalledWith('12345', 'bici');
  });
});

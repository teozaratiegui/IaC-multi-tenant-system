'use strict';

const { createMessages } = require('./messages');

const ACME = createMessages({
  orgDisplayName: 'acme',
  locale: 'es-AR',
  timeZone: 'America/Argentina/Buenos_Aires',
});

describe('the unauthorised-movement alert', () => {
  test('is exactly the text the owner has always received', () => {
    // Character for character: this string is the specification, and a locale
    // default drifting under it is a regression only the owner would see.
    const text = ACME.unauthorizedAlert(
      { tagId: 'E280A1B2', tagName: 'bici' },
      '2026-09-12T17:32:05.000Z',
    );

    expect(text).toBe(
      'Alerta: Se detectó un movimiento no autorizado de su tag "bici" ' +
        'por parte del lector de acme a las 12/9/26 14:32:05',
    );
  });

  test('falls back to the tag id, unquoted, when the tag has no name', () => {
    const text = ACME.unauthorizedAlert({ tagId: 'E280A1B2', tagName: '' }, '2026-09-12T17:32:05Z');
    expect(text).toContain('de su tag E280A1B2 por parte');
  });

  test('an unparseable timestamp degrades to the raw value instead of throwing', () => {
    const text = ACME.unauthorizedAlert({ tagId: 'E280', tagName: '' }, 'not-a-date');
    expect(text).toContain('not-a-date');
  });
});

describe('a tenant somewhere else', () => {
  test('gets its own name, locale and timezone without a line of code changing', () => {
    const messages = createMessages({
      orgDisplayName: 'Facultad de Ingeniería',
      locale: 'en-US',
      timeZone: 'UTC',
    });

    const text = messages.unauthorizedAlert({ tagId: 'E1', tagName: 'bike' }, '2026-09-12T17:32:05Z');

    expect(text).toContain('lector de Facultad de Ingeniería');
    expect(text).toContain('9/12/26 17:32:05');
  });
});

describe('the bot replies', () => {
  test('help lists every command, including the ones added since', () => {
    const help = ACME.help();
    for (const command of ['/status', '/lock', '/unlock', '/help']) {
      expect(help).toContain(command);
    }
  });

  test('a chat with no tags is told what to do about it', () => {
    expect(ACME.noTags()).toBe(
      'No hay ningún tag asociado a este chat. Contacte al administrador.',
    );
  });

  test('an unknown command points at /help', () => {
    expect(ACME.unknownCommand()).toContain('/help');
  });

  test('the list shows one line per tag with its state', () => {
    const text = ACME.tagList([
      { tagId: 'E1', tagName: 'bici', allowed: true },
      { tagId: 'E2', tagName: '', allowed: false },
    ]);
    expect(text).toContain('• bici: desbloqueado (acceso habilitado)');
    expect(text).toContain('• E2: bloqueado (acceso deshabilitado)');
  });

  test('the detail carries name, id, state and owner', () => {
    const text = ACME.tagStatus({
      tagId: 'E1',
      tagName: 'bici',
      allowed: false,
      ownerName: 'Teo',
      ownerLastName: 'Zaratiegui',
    });
    expect(text).toContain('Nombre: bici');
    expect(text).toContain('ID: E1');
    expect(text).toContain('Estado: bloqueado (acceso deshabilitado)');
    expect(text).toContain('Titular: Teo Zaratiegui');
  });

  test('lock and unlock warn that readers take up to five minutes to catch up', () => {
    // The gateway caches the decision for 300 s and nothing invalidates it, so
    // without this line the bot says "unlocked" and the door keeps refusing.
    expect(ACME.locked('bici')).toContain('5 minutos');
    expect(ACME.unlocked('bici')).toContain('5 minutos');
    expect(ACME.locked('bici')).toContain('bloqueado');
    expect(ACME.unlocked('bici')).toContain('desbloqueado');
  });

  test('a name nobody owns is reported with the name that was asked for', () => {
    expect(ACME.tagNotFound('auto')).toContain('"auto"');
  });

  test('a command that needs an argument says how to give it', () => {
    expect(ACME.missingArgument('lock')).toContain('/lock');
  });
});

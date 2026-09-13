'use strict';

const { ownerFullName, tagLabel } = require('./tag');

/**
 * Every piece of text a person ever reads from this use case, in one catalogue,
 * parameterised by the tenant.
 *
 * The deployed code hardcoded `es-AR`, `America/Argentina/Buenos_Aires` and
 * printed `ORG_NAME` — which is the slug, so the owner read "el lector de acme".
 * A tenant anywhere else now sets three environment variables and gets its own
 * name, language and clock without a line of code changing. That is the same
 * multi-tenancy the infrastructure already has, carried into presentation.
 *
 * The alert text itself is a specification, not a default: it is asserted
 * character for character in messages.test.js.
 */

/** How long a decision can stay cached in the Fog gateway before a reader sees a change. */
const PROPAGATION_WARNING = 'Puede demorar hasta 5 minutos en aplicarse en los lectores.';

function createMessages({ orgDisplayName, locale, timeZone }) {
  /**
   * `12/9/26 14:32:05`.
   *
   * Date and time are formatted separately and joined with a space rather than
   * with `dateStyle`+`timeStyle`, which inserts a comma and, for es-AR, renders
   * "2:32:05 p. m." — neither is the text the owner has been receiving.
   */
  function formatTimestamp(isoString) {
    const when = new Date(isoString);
    if (Number.isNaN(when.getTime())) return String(isoString);
    try {
      const date = when.toLocaleDateString(locale, { timeZone, dateStyle: 'short' });
      const time = when.toLocaleTimeString(locale, {
        timeZone,
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      return `${date} ${time}`;
    } catch {
      // An invalid locale or timezone must not cost the owner their alert.
      return String(isoString);
    }
  }

  function allowedLabel(allowed) {
    return allowed ? 'desbloqueado (acceso habilitado)' : 'bloqueado (acceso deshabilitado)';
  }

  return {
    formatTimestamp,
    allowedLabel,

    unauthorizedAlert(record, timestampIso) {
      const label = record?.tagName ? `"${record.tagName}"` : record?.tagId;
      return (
        `Alerta: Se detectó un movimiento no autorizado de su tag ${label} ` +
        `por parte del lector de ${orgDisplayName} a las ${formatTimestamp(timestampIso)}`
      );
    },

    help() {
      return [
        'Comandos disponibles:',
        '/status — listar todos sus tags',
        '/status <nombre> — estado de un tag',
        '/lock <nombre> — bloquear un tag',
        '/unlock <nombre> — desbloquear un tag',
        '/help — mostrar esta ayuda',
      ].join('\n');
    },

    noTags() {
      return 'No hay ningún tag asociado a este chat. Contacte al administrador.';
    },

    unknownCommand() {
      return 'Comando desconocido. Envíe /help para ver los comandos disponibles.';
    },

    tagList(tags) {
      const lines = tags.map((tag) => `• ${tagLabel(tag)}: ${allowedLabel(tag.allowed)}`);
      return `Tags asociados a este chat:\n${lines.join('\n')}\n\nUse /status <nombre> para ver detalle.`;
    },

    tagStatus(tag) {
      const owner = ownerFullName(tag);
      const ownerLine = owner ? `\nTitular: ${owner}` : '';
      const nameLine = tag.tagName ? `Nombre: ${tag.tagName}\n` : '';
      return `${nameLine}ID: ${tag.tagId}\nEstado: ${allowedLabel(tag.allowed)}${ownerLine}`;
    },

    tagNotFound(name) {
      return `No se encontró un tag con el nombre "${name}" en este chat.`;
    },

    missingArgument(command) {
      return `Indique el nombre del tag. Ejemplo: /${command} auto`;
    },

    // The gateway caches the decision for 300 s and nothing invalidates it, so
    // without this sentence the bot says "unlocked" and the reader keeps
    // refusing for up to five minutes. Telling the user is cheaper and more
    // honest than letting them discover it at the door (finding G18).
    locked(label) {
      return `Tag "${label}" bloqueado. El acceso quedó deshabilitado.\n${PROPAGATION_WARNING}`;
    },

    unlocked(label) {
      return `Tag "${label}" desbloqueado. El acceso quedó habilitado.\n${PROPAGATION_WARNING}`;
    },
  };
}

module.exports = { createMessages, PROPAGATION_WARNING };

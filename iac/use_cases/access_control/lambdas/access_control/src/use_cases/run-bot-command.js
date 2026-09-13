'use strict';

/** `/status bici` → { command: 'status', arg: 'bici' }. Case and blanks folded. */
const COMMAND = /^\/(\w+)(?:\s+(.+))?$/s;

function parseCommand(text) {
  const match = String(text ?? '').trim().match(COMMAND);
  if (!match) return { command: '', arg: '' };
  return { command: match[1].toLowerCase(), arg: (match[2] || '').trim() };
}

/**
 * The conversational administration interface: what the owner of a tag can do
 * without an operator.
 *
 * Tags are resolved **by name within the sender's chat**, never by id. That is
 * the whole authorisation model — one chat cannot name another chat's tag — and
 * it is why the chatId-index exists and why it now has the normalised name as
 * its range key: every command here is a read of a single item.
 *
 * Provider-agnostic on purpose: it receives `{ from, text }` and answers with
 * text. Whether that arrived from Telegram or WhatsApp, and how the reply is
 * delivered, is the inbound adapter's and the messenger's business.
 */
class RunBotCommandUseCase {
  constructor({ tagRepository, messages }) {
    this.tags = tagRepository;
    this.messages = messages;
  }

  /**
   * @param {{from: string, text: string}} message
   * @returns {Promise<{replyText: string}>}
   */
  async execute(message) {
    const { command, arg } = parseCommand(message.text);

    // Answered before any lookup: it is the first thing a new chat sends, and
    // it has to work for someone who owns nothing yet.
    if (command === 'help' || command === 'start') {
      return { replyText: this.messages.help() };
    }

    if (command === 'status') return this.status(message.from, arg);
    if (command === 'lock' || command === 'unlock') {
      return this.setAllowed(message.from, command, arg);
    }

    return { replyText: this.messages.unknownCommand() };
  }

  async status(chatId, name) {
    if (!name) {
      const tags = await this.tags.findByChat(chatId);
      if (tags.length === 0) return { replyText: this.messages.noTags() };
      return { replyText: this.messages.tagList(tags) };
    }

    const tag = await this.tags.findByChatAndName(chatId, name);
    if (!tag) return this.explainMiss(chatId, name);
    return { replyText: this.messages.tagStatus(tag) };
  }

  async setAllowed(chatId, command, name) {
    if (!name) return { replyText: this.messages.missingArgument(command) };

    const tag = await this.tags.findByChatAndName(chatId, name);
    if (!tag) return this.explainMiss(chatId, name);

    const allowed = command === 'unlock';
    const written = await this.tags.setAllowed(tag.tagId, allowed);
    if (!written) {
      // The tag was deleted between the lookup and the write. Rare, but
      // claiming success would be a lie the owner acts on.
      return { replyText: this.messages.tagNotFound(name) };
    }

    const label = tag.tagName || tag.tagId;
    return { replyText: allowed ? this.messages.unlocked(label) : this.messages.locked(label) };
  }

  /**
   * A miss can mean two different things, and they deserve different answers:
   * a chat with tags mistyped a name; a chat with none needs an administrator.
   * The second lookup only ever runs on this error path.
   */
  async explainMiss(chatId, name) {
    const tags = await this.tags.findByChat(chatId);
    if (tags.length === 0) return { replyText: this.messages.noTags() };
    return { replyText: this.messages.tagNotFound(name) };
  }
}

module.exports = { RunBotCommandUseCase, parseCommand };

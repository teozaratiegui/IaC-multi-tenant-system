'use strict';

const { STATUS } = require('../domain/decisions');
const { associationAttributes } = require('../domain/tag');
const { badRequest, conflict } = require('./replies');

/**
 * Creates a tag.
 *
 * This is the answer to "how does a tag get into production?" — a question the
 * deployed system had no answer to: `associate` required the tag to exist, and
 * the only thing that created tags was auto-registration, which is a
 * development convenience and off in production by design.
 *
 * The association is optional and, when given, is written in the same item:
 * registering a new bike and naming its owner is one gesture, so it should be
 * one call and one write.
 *
 * When it is given it goes through the same duplicate-name check as `associate`.
 * The two operations write the same attributes, so a rule one of them enforces
 * and the other does not is not a rule: `provision` used to condition only on
 * `attribute_not_exists(tagId)`, which let two different tags end up sharing a
 * (chatId, tagNameNormalized) pair — the chat index's full key. `/lock bici`
 * then resolved to one of them arbitrarily (the query takes Limit 1) and told
 * the owner the access was disabled, while the other tag stayed open.
 */
class ProvisionTagUseCase {
  constructor({ tagRepository, now = () => new Date() }) {
    this.tags = tagRepository;
    this.now = now;
  }

  /**
   * @param {{tag: string, allowed?: boolean, chatId?: string, tagName?: string,
   *          ownerName?: string, ownerLastName?: string}} input
   * @returns {Promise<{status: number, body: object}>}
   */
  async execute(input) {
    const tagId = String(input.tag ?? '').trim();
    if (!tagId) return badRequest('Campo requerido: tag');

    // Either no association at all, or a complete one. Half of it would create
    // an item that is invisible in the chat index.
    let association;
    if (input.chatId || input.tagName || input.ownerName || input.ownerLastName) {
      try {
        association = associationAttributes(input);
      } catch (error) {
        return badRequest(error.message);
      }
    }

    // Same guard as `associate`, for the same reason: two tags sharing a
    // (chat, name) pair make every later /status, /lock and /unlock ambiguous.
    // Not atomic with the write — two operators racing the same name can still
    // both pass it — which is the limitation documented on AssociateTagUseCase.
    if (association) {
      const sameName = await this.tags.findByChatAndName(association.chatId, association.tagName);
      if (sameName) {
        return conflict('Ya existe otro tag con ese nombre en este chat', {
          tagName: association.tagName,
        });
      }
    }

    const outcome = await this.tags.provision({
      tagId,
      allowed: input.allowed === undefined ? true : Boolean(input.allowed),
      registeredAt: this.now().toISOString(),
      association,
    });

    if (outcome === 'exists') {
      return conflict('Ya existe un tag con ese identificador', { tag: tagId });
    }

    const created = await this.tags.findById(tagId);
    return {
      status: STATUS.CREATED,
      body: {
        ok: true,
        tag: tagId,
        allowed: created?.allowed ?? true,
        ...(association ? { tagName: association.tagName, chatId: association.chatId } : {}),
        message: 'Tag creado correctamente',
      },
    };
  }
}

module.exports = { ProvisionTagUseCase };

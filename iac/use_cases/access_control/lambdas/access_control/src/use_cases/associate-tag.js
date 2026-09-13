'use strict';

const { STATUS } = require('../domain/decisions');
const { associationAttributes } = require('../domain/tag');
const { badRequest, notFound, conflict } = require('./replies');

/**
 * Binds an existing tag to a chat and an owner.
 *
 * It deliberately does not create the tag it cannot find: a mistyped EPC has to
 * fail loudly, because a phantom tag is a row nobody will ever scan and nobody
 * will ever notice. Creating one is `provision-tag`, a separate operation the
 * caller has to ask for by name.
 *
 * Known limitation, accepted at this scale: the duplicate-name check and the
 * write are not atomic, so two operators naming two tags the same at the same
 * instant can both pass it. Closing that properly needs a separate uniqueness
 * item per (chat, name); the cost is not worth it for one tenant.
 */
class AssociateTagUseCase {
  constructor({ tagRepository }) {
    this.tags = tagRepository;
  }

  /**
   * @param {{tag: string, chatId: string, tagName: string,
   *          ownerName?: string, ownerLastName?: string}} input
   * @returns {Promise<{status: number, body: object}>}
   */
  async execute(input) {
    const tagId = String(input.tag ?? '').trim();
    if (!tagId) return badRequest('Campo requerido: tag');

    // The domain object is what enforces "a chatId always comes with a
    // normalised name"; building it here is also the field validation.
    let attributes;
    try {
      attributes = associationAttributes(input);
    } catch (error) {
      return badRequest(error.message);
    }

    const sameName = await this.tags.findByChatAndName(attributes.chatId, attributes.tagName);
    if (sameName && sameName.tagId !== tagId) {
      return conflict('Ya existe otro tag con ese nombre en este chat', {
        tagName: attributes.tagName,
      });
    }

    const outcome = await this.tags.associate({
      tagId,
      chatId: attributes.chatId,
      tagName: attributes.tagName,
      ownerName: attributes.ownerName,
      ownerLastName: attributes.ownerLastName,
    });

    if (outcome === 'not_found') {
      return notFound('No existe un tag con ese identificador', { tag: tagId });
    }

    const updated = await this.tags.findById(tagId);
    return {
      status: STATUS.OK,
      body: {
        ok: true,
        tag: updated?.tagId ?? tagId,
        tagName: updated?.tagName ?? attributes.tagName,
        chatId: updated?.chatId ?? attributes.chatId,
        ownerName: updated?.ownerName ?? attributes.ownerName,
        ownerLastName: updated?.ownerLastName ?? attributes.ownerLastName,
        message: 'Tag asociado correctamente',
      },
    };
  }
}

module.exports = { AssociateTagUseCase };

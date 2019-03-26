/**
 * @module structs
 */

import { AbstractItem, logItemHelper, AbstractItemRef } from './AbstractItem.js'
import * as encoding from 'lib0/encoding.js'
import * as decoding from 'lib0/decoding.js'
import { Y } from '../utils/Y.js' // eslint-disable-line
import { ID } from '../utils/ID.js' // eslint-disable-line
import { ItemType } from './ItemType.js' // eslint-disable-line
import { getItemCleanEnd, getItemCleanStart, getItemType } from '../utils/StructStore.js'
import { Transaction } from '../utils/Transaction.js' // eslint-disable-line

export const structFormatRefNumber = 4

export class ItemFormat extends AbstractItem {
  /**
   * @param {ID} id
   * @param {AbstractItem | null} left
   * @param {AbstractItem | null} right
   * @param {ItemType | null} parent
   * @param {string | null} parentSub
   * @param {string} key
   * @param {any} value
   */
  constructor (id, left, right, parent, parentSub, key, value) {
    super(id, left, right, parent, parentSub)
    this.key = key
    this.value = value
  }
  /**
   * @param {ID} id
   * @param {AbstractItem | null} left
   * @param {AbstractItem | null} right
   * @param {ItemType | null} parent
   * @param {string | null} parentSub
   */
  copy (id, left, right, parent, parentSub) {
    return new ItemFormat(id, left, right, parent, parentSub, this.key, this.value)
  }
  /**
   * Transform this Type to a readable format.
   * Useful for logging as all Items and Delete implement this method.
   *
   * @private
   */
  logString () {
    return logItemHelper('ItemFormat', this, `key:${JSON.stringify(this.key)},value:${JSON.stringify(this.value)}`)
  }
  get _length () {
    return 1
  }
  get _countable () {
    return false
  }
  /**
   * @param {encoding.Encoder} encoder
   */
  write (encoder) {
    super.write(encoder, structFormatRefNumber)
    encoding.writeVarString(encoder, this.key)
    encoding.writeVarString(encoder, JSON.stringify(this.value))
  }
}

export class ItemFormatRef extends AbstractItemRef {
  /**
   * @param {decoding.Decoder} decoder
   * @param {number} info
   */
  constructor (decoder, info) {
    super(decoder, info)
    /**
     * @type {string}
     */
    this.key = decoding.readVarString(decoder)
    this.value = JSON.parse(decoding.readVarString(decoder))
  }
  /**
   * @param {Transaction} transaction
   * @return {ItemFormat}
   */
  toStruct (transaction) {
    const store = transaction.y.store
    return new ItemFormat(
      this.id,
      this.left === null ? null : getItemCleanEnd(store, transaction, this.left),
      this.right === null ? null : getItemCleanStart(store, transaction, this.right),
      this.parent === null ? null : getItemType(store, this.parent),
      this.parentSub,
      this.key,
      this.value
    )
  }
}
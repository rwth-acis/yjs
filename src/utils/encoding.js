
/**
 * @module encoding
 */

import {
  findIndexSS,
  GCRef,
  ItemBinaryRef,
  ItemDeletedRef,
  ItemEmbedRef,
  ItemFormatRef,
  ItemJSONRef,
  ItemStringRef,
  ItemTypeRef,
  writeID,
  createID,
  readID,
  getState,
  getStateVector,
  readDeleteSet,
  writeDeleteSet,
  createDeleteSetFromStructStore,
  Doc, Transaction, AbstractStruct, AbstractStructRef, StructStore, ID // eslint-disable-line
} from '../internals.js'

import * as encoding from 'lib0/encoding.js'
import * as decoding from 'lib0/decoding.js'
import * as binary from 'lib0/binary.js'

/**
 * @private
 */
export const structRefs = [
  GCRef,
  ItemBinaryRef,
  ItemDeletedRef,
  ItemEmbedRef,
  ItemFormatRef,
  ItemJSONRef,
  ItemStringRef,
  ItemTypeRef
]

/**
 * @param {encoding.Encoder} encoder
 * @param {Array<AbstractStruct>} structs All structs by `client`
 * @param {number} client
 * @param {number} clock write structs starting with `ID(client,clock)`
 *
 * @function
 */
const writeStructs = (encoder, structs, client, clock) => {
  // write first id
  const startNewStructs = findIndexSS(structs, clock)
  // write # encoded structs
  encoding.writeVarUint(encoder, structs.length - startNewStructs)
  writeID(encoder, createID(client, clock))
  const firstStruct = structs[startNewStructs]
  // write first struct with an offset
  firstStruct.write(encoder, clock - firstStruct.id.clock, 0)
  for (let i = startNewStructs + 1; i < structs.length; i++) {
    structs[i].write(encoder, 0, 0)
  }
}

/**
 * @param {decoding.Decoder} decoder
 * @param {number} numOfStructs
 * @param {ID} nextID
 * @return {Array<AbstractStructRef>}
 *
 * @private
 * @function
 */
const readStructRefs = (decoder, numOfStructs, nextID) => {
  /**
   * @type {Array<AbstractStructRef>}
   */
  const refs = []
  for (let i = 0; i < numOfStructs; i++) {
    const info = decoding.readUint8(decoder)
    const ref = new structRefs[binary.BITS5 & info](decoder, nextID, info)
    nextID = createID(nextID.client, nextID.clock + ref.length)
    refs.push(ref)
  }
  return refs
}

/**
 * @param {encoding.Encoder} encoder
 * @param {StructStore} store
 * @param {Map<number,number>} _sm
 *
 * @private
 * @function
 */
export const writeClientsStructs = (encoder, store, _sm) => {
  // we filter all valid _sm entries into sm
  const sm = new Map()
  _sm.forEach((clock, client) => {
    // only write if new structs are available
    if (getState(store, client) > clock) {
      sm.set(client, clock)
    }
  })
  getStateVector(store).forEach((clock, client) => {
    if (!_sm.has(client)) {
      sm.set(client, 0)
    }
  })
  // write # states that were updated
  encoding.writeVarUint(encoder, sm.size)
  sm.forEach((clock, client) => {
    // @ts-ignore
    writeStructs(encoder, store.clients.get(client), client, clock)
  })
}

/**
 * @param {decoding.Decoder} decoder The decoder object to read data from.
 * @return {Map<number,Array<AbstractStructRef>>}
 *
 * @private
 * @function
 */
export const readClientsStructRefs = decoder => {
  /**
   * @type {Map<number,Array<AbstractStructRef>>}
   */
  const clientRefs = new Map()
  const numOfStateUpdates = decoding.readVarUint(decoder)
  for (let i = 0; i < numOfStateUpdates; i++) {
    const numberOfStructs = decoding.readVarUint(decoder)
    const nextID = readID(decoder)
    const refs = readStructRefs(decoder, numberOfStructs, nextID)
    clientRefs.set(nextID.client, refs)
  }
  return clientRefs
}

/**
 * Resume computing structs generated by struct readers.
 *
 * While there is something to do, we integrate structs in this order
 * 1. top element on stack, if stack is not empty
 * 2. next element from current struct reader (if empty, use next struct reader)
 *
 * If struct causally depends on another struct (ref.missing), we put next reader of
 * `ref.id.client` on top of stack.
 *
 * At some point we find a struct that has no causal dependencies,
 * then we start emptying the stack.
 *
 * It is not possible to have circles: i.e. struct1 (from client1) depends on struct2 (from client2)
 * depends on struct3 (from client1). Therefore the max stack size is eqaul to `structReaders.length`.
 *
 * This method is implemented in a way so that we can resume computation if this update
 * causally depends on another update.
 *
 * @param {Transaction} transaction
 * @param {StructStore} store
 *
 * @private
 * @function
 */
const resumeStructIntegration = (transaction, store) => {
  const stack = store.pendingStack
  const clientsStructRefs = store.pendingClientsStructRefs
  // iterate over all struct readers until we are done
  while (stack.length !== 0 || clientsStructRefs.size !== 0) {
    if (stack.length === 0) {
      // take any first struct from clientsStructRefs and put it on the stack
      const [client, structRefs] = clientsStructRefs.entries().next().value
      stack.push(structRefs.refs[structRefs.i++])
      if (structRefs.refs.length === structRefs.i) {
        clientsStructRefs.delete(client)
      }
    }
    const ref = stack[stack.length - 1]
    const m = ref._missing
    const client = ref.id.client
    const localClock = getState(store, client)
    const offset = ref.id.clock < localClock ? localClock - ref.id.clock : 0
    if (ref.id.clock + offset !== localClock) {
      // A previous message from this client is missing
      // check if there is a pending structRef with a smaller clock and switch them
      const structRefs = clientsStructRefs.get(client)
      if (structRefs !== undefined) {
        const r = structRefs.refs[structRefs.i]
        if (r.id.clock < ref.id.clock) {
          // put ref with smaller clock on stack instead and continue
          structRefs.refs[structRefs.i] = ref
          stack[stack.length - 1] = r
          // sort the set because this approach might bring the list out of order
          structRefs.refs = structRefs.refs.slice(structRefs.i).sort((r1, r2) => r1.id.clock - r2.id.clock)
          structRefs.i = 0
          continue
        }
      }
      // wait until missing struct is available
      return
    }
    while (m.length > 0) {
      const missing = m[m.length - 1]
      if (getState(store, missing.client) <= missing.clock) {
        const client = missing.client
        // get the struct reader that has the missing struct
        const structRefs = clientsStructRefs.get(client)
        if (structRefs === undefined) {
          // This update message causally depends on another update message.
          return
        }
        stack.push(structRefs.refs[structRefs.i++])
        if (structRefs.i === structRefs.refs.length) {
          clientsStructRefs.delete(client)
        }
        break
      }
      ref._missing.pop()
    }
    if (m.length === 0) {
      if (offset < ref.length) {
        ref.toStruct(transaction, store, offset).integrate(transaction)
      }
      stack.pop()
    }
  }
}

/**
 * @param {Transaction} transaction
 * @param {StructStore} store
 *
 * @private
 * @function
 */
export const tryResumePendingDeleteReaders = (transaction, store) => {
  const pendingReaders = store.pendingDeleteReaders
  store.pendingDeleteReaders = []
  for (let i = 0; i < pendingReaders.length; i++) {
    readDeleteSet(pendingReaders[i], transaction, store)
  }
}

/**
 * @param {encoding.Encoder} encoder
 * @param {Transaction} transaction
 *
 * @private
 * @function
 */
export const writeStructsFromTransaction = (encoder, transaction) => writeClientsStructs(encoder, transaction.doc.store, transaction.beforeState)

/**
 * @param {StructStore} store
 * @param {Map<number, Array<AbstractStructRef>>} clientsStructsRefs
 *
 * @private
 * @function
 */
const mergeReadStructsIntoPendingReads = (store, clientsStructsRefs) => {
  const pendingClientsStructRefs = store.pendingClientsStructRefs
  for (const [client, structRefs] of clientsStructsRefs) {
    const pendingStructRefs = pendingClientsStructRefs.get(client)
    if (pendingStructRefs === undefined) {
      pendingClientsStructRefs.set(client, { refs: structRefs, i: 0 })
    } else {
      // merge into existing structRefs
      const merged = pendingStructRefs.i > 0 ? pendingStructRefs.refs.slice(pendingStructRefs.i) : pendingStructRefs.refs
      for (let i = 0; i < structRefs.length; i++) {
        merged.push(structRefs[i])
      }
      pendingStructRefs.i = 0
      pendingStructRefs.refs = merged.sort((r1, r2) => r1.id.clock - r2.id.clock)
    }
  }
}

/**
 * Read the next Item in a Decoder and fill this Item with the read data.
 *
 * This is called when data is received from a remote peer.
 *
 * @param {decoding.Decoder} decoder The decoder object to read data from.
 * @param {Transaction} transaction
 * @param {StructStore} store
 *
 * @private
 * @function
 */
export const readStructs = (decoder, transaction, store) => {
  const clientsStructRefs = readClientsStructRefs(decoder)
  mergeReadStructsIntoPendingReads(store, clientsStructRefs)
  resumeStructIntegration(transaction, store)
  tryResumePendingDeleteReaders(transaction, store)
}

/**
 * Read and apply a document update.
 *
 * This function has the same effect as `applyUpdate` but accepts an decoder.
 *
 * @param {decoding.Decoder} decoder
 * @param {Doc} ydoc
 * @param {any} [transactionOrigin] This will be stored on `transaction.origin` and `.on('update', (update, origin))`
 *
 * @function
 */
export const readUpdate = (decoder, ydoc, transactionOrigin) =>
  ydoc.transact(transaction => {
    readStructs(decoder, transaction, ydoc.store)
    readDeleteSet(decoder, transaction, ydoc.store)
  }, transactionOrigin)

/**
 * Apply a document update created by, for example, `y.on('update', update => ..)` or `update = encodeStateAsUpdate()`.
 *
 * This function has the same effect as `readUpdate` but accepts an Uint8Array instead of a Decoder.
 *
 * @param {Doc} ydoc
 * @param {Uint8Array} update
 * @param {any} [transactionOrigin] This will be stored on `transaction.origin` and `.on('update', (update, origin))`
 *
 * @function
 */
export const applyUpdate = (ydoc, update, transactionOrigin) =>
  readUpdate(decoding.createDecoder(update), ydoc, transactionOrigin)

/**
 * Write all the document as a single update message. If you specify the state of the remote client (`targetStateVector`) it will
 * only write the operations that are missing.
 *
 * @param {encoding.Encoder} encoder
 * @param {Doc} doc
 * @param {Map<number,number>} [targetStateVector] The state of the target that receives the update. Leave empty to write all known structs
 *
 * @function
 */
export const writeStateAsUpdate = (encoder, doc, targetStateVector = new Map()) => {
  writeClientsStructs(encoder, doc.store, targetStateVector)
  writeDeleteSet(encoder, createDeleteSetFromStructStore(doc.store))
}

/**
 * Write all the document as a single update message that can be applied on the remote document. If you specify the state of the remote client (`targetState`) it will
 * only write the operations that are missing.
 *
 * Use `writeStateAsUpdate` instead if you are working with lib0/encoding.js#Encoder
 *
 * @param {Doc} doc
 * @param {Uint8Array} [encodedTargetStateVector] The state of the target that receives the update. Leave empty to write all known structs
 * @return {Uint8Array}
 *
 * @function
 */
export const encodeStateAsUpdate = (doc, encodedTargetStateVector) => {
  const encoder = encoding.createEncoder()
  const targetStateVector = encodedTargetStateVector == null ? new Map() : decodeStateVector(encodedTargetStateVector)
  writeStateAsUpdate(encoder, doc, targetStateVector)
  return encoding.toUint8Array(encoder)
}

/**
 * Read state vector from Decoder and return as Map
 *
 * @param {decoding.Decoder} decoder
 * @return {Map<number,number>} Maps `client` to the number next expected `clock` from that client.
 *
 * @function
 */
export const readStateVector = decoder => {
  const ss = new Map()
  const ssLength = decoding.readVarUint(decoder)
  for (let i = 0; i < ssLength; i++) {
    const client = decoding.readVarUint(decoder)
    const clock = decoding.readVarUint(decoder)
    ss.set(client, clock)
  }
  return ss
}

/**
 * Read decodedState and return State as Map.
 *
 * @param {Uint8Array} decodedState
 * @return {Map<number,number>} Maps `client` to the number next expected `clock` from that client.
 *
 * @function
 */
export const decodeStateVector = decodedState => readStateVector(decoding.createDecoder(decodedState))

/**
 * Write State Vector to `lib0/encoding.js#Encoder`.
 *
 * @param {encoding.Encoder} encoder
 * @param {Doc} doc
 *
 * @function
 */
export const writeDocumentStateVector = (encoder, doc) => {
  encoding.writeVarUint(encoder, doc.store.clients.size)
  doc.store.clients.forEach((structs, client) => {
    const struct = structs[structs.length - 1]
    const id = struct.id
    encoding.writeVarUint(encoder, id.client)
    encoding.writeVarUint(encoder, id.clock + struct.length)
  })
  return encoder
}

/**
 * Encode State as Uint8Array.
 *
 * @param {Doc} doc
 * @return {Uint8Array}
 *
 * @function
 */
export const encodeStateVector = doc => {
  const encoder = encoding.createEncoder()
  writeDocumentStateVector(encoder, doc)
  return encoding.toUint8Array(encoder)
}

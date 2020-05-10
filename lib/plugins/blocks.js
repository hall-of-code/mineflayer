const vec3 = require('vec3')
const Vec3 = vec3.Vec3
const assert = require('assert')
const Painting = require('../painting')
const Location = require('../location')

module.exports = inject

const paintingFaceToVec = [
  new Vec3(0, 0, -1),
  new Vec3(-1, 0, 0),
  new Vec3(0, 0, 1),
  new Vec3(1, 0, 0)
]

const inChunkMod = new Vec3(16, 256, 16)

function inject (bot, { version }) {
  const nbt = require('prismarine-nbt')
  const Chunk = require('prismarine-chunk')(version)
  const ChatMessage = require('../chat_message')(version)
  const signs = {}
  const paintingsByPos = {}
  const paintingsById = {}
  const blockEntities = new Map()

  let columns = {}

  function addPainting (painting) {
    paintingsById[painting.id] = painting
    paintingsByPos[painting.position] = painting
  }

  function deletePainting (painting) {
    delete paintingsById[painting.id]
    delete paintingsByPos[painting.position]
  }

  function addBlockEntity (nbtData) {
    const blockEntity = nbt.simplify(nbtData)
    const absolutePoint = new Vec3(blockEntity.x, blockEntity.y, blockEntity.z)
    const loc = new Location(absolutePoint)

    // Handle signs
    if (blockEntity.id === 'minecraft:sign' || blockEntity.id === 'Sign') {
      const prepareJson = (i) => {
        const data = blockEntity[`Text${i}`]

        if (data === '') return ''

        const json = JSON.parse(data)
        if (!('text' in json)) return ''

        json.text = json.text.replace(/^"|"$/g, '')
        return json
      }

      blockEntity.Text1 = new ChatMessage(prepareJson(1))
      blockEntity.Text2 = new ChatMessage(prepareJson(2))
      blockEntity.Text3 = new ChatMessage(prepareJson(3))
      blockEntity.Text4 = new ChatMessage(prepareJson(4))

      signs[loc.floored] = [
        blockEntity.Text1.toString(),
        blockEntity.Text2.toString(),
        blockEntity.Text3.toString(),
        blockEntity.Text4.toString()
      ].join('\n')
    }

    blockEntities[loc.floored] = blockEntity
  }

  function delColumn (chunkX, chunkY) {
    const columnCorner = new Vec3(chunkX * 16, 0, chunkY * 16)
    const key = columnKeyXZ(columnCorner.x, columnCorner.z)

    delete columns[key]

    bot.emit('chunkColumnUnload', columnCorner)
  }

  function addColumn (args) {
    const columnCorner = new Vec3(args.x * 16, 0, args.z * 16)
    const key = columnKeyXZ(columnCorner.x, columnCorner.z)

    if (!args.bitMap) {
      // stop storing the chunk column
      delColumn(args.x, args.z)
      return
    }

    const column = columns[key] || (columns[key] = new Chunk())

    try {
      column.load(args.data, args.bitMap, args.skyLightSent)

      if (args.biomes !== undefined) {
        column.loadBiomes(args.biomes)
      }
    } catch (e) {
      bot.emit('error', e)
      return
    }

    bot.emit('chunkColumnLoad', columnCorner)
  }

  function findBlock (options) {
    let check = options.matching
    if (typeof (options.matching) !== 'function') {
      if (!Array.isArray(options.matching)) {
        options.matching = [options.matching]
      }

      check = isMatchingType
    }

    options.point = options.point || bot.entity.position
    options.maxDistance = options.maxDistance || 16

    const cursor = vec3()
    const point = options.point
    const max = options.maxDistance

    for (cursor.x = point.x - max; cursor.x < point.x + max; cursor.x++) {
      for (cursor.y = point.y - max; cursor.y < point.y + max; cursor.y++) {
        for (cursor.z = point.z - max; cursor.z < point.z + max; cursor.z++) {
          const found = bot.blockAt(cursor)

          if (check(found)) {
            return found
          }
        }
      }
    }

    return null

    function isMatchingType (block) {
      return block === null ? false : options.matching.indexOf(block.type) >= 0
    }
  }

  function posInChunk (pos) {
    return pos.floored().modulus(inChunkMod)
  }

  function blockAt (absolutePoint) {
    const loc = new Location(absolutePoint)
    const key = columnKeyXZ(loc.chunkCorner.x, loc.chunkCorner.z)

    const column = columns[key]
    // null column means chunk not loaded
    if (!column) return null

    const block = column.getBlock(posInChunk(absolutePoint))
    block.position = loc.floored
    block.signText = signs[loc.floored]
    block.painting = paintingsByPos[loc.floored]
    block.blockEntity = blockEntities[loc.floored]

    return block
  }

  function blockIsNotEmpty (pos) {
    const block = bot.blockAt(pos)
    return block !== null && block.boundingBox !== 'empty'
  }

  // maybe this should be moved to math.js instead?
  function visiblePosition (a, b) {
    let v = b.minus(a)
    const t = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
    const u = t * 5

    v.scale(1 / u)

    let na
    for (let i = 1; i < u; i++) {
      na = a.plus(v)

      // check that blocks don't inhabit the same position
      if (!na.floored().equals(a.floored())) {
        // check block is not transparent
        if (blockIsNotEmpty(na)) {
          return false
        }
      }

      a = na
    }

    return true
  }

  // if passed in block is within line of sight to the bot, returns true
  // also works on anything with a position value
  function canSeeBlock (block) {
    // this emits a ray from the center of the bots body to the block
    if (visiblePosition(bot.entity.position.offset(0, bot.entity.height * 0.5, 0), block.position)) {
      return true
    }

    return false
  }

  function chunkColumn (x, z) {
    return columns[columnKeyXZ(x, z)]
  }

  function emitBlockUpdate (oldBlock, newBlock) {
    bot.emit('blockUpdate', oldBlock, newBlock)

    const position = oldBlock 
      ? oldBlock.position
      : (newBlock ? newBlock.position : null)

    if (position) {
      bot.emit(`blockUpdate:${newBlock.position}`, oldBlock, newBlock)
    }
  }

  bot._client.on('unload_chunk', (packet) => {
    delColumn(packet.x, packet.z)
  })

  function updateBlockState (point, stateId) {
    const oldBlock = blockAt(point)
    const loc = new Location(point)
    const key = columnKeyXZ(loc.chunkCorner.x, loc.chunkCorner.z)
    const column = columns[key]

    // sometimes minecraft server sends us block updates before it sends
    // us the column that the block is in. ignore this.
    if (!column) {
      return
    }

    column.setBlockStateId(posInChunk(point), stateId)

    const newBlock = blockAt(point)
    if (oldBlock.type !== newBlock.type) {
      delete blockEntities[loc.floored]
      delete signs[loc.floored]

      const painting = paintingsByPos[loc.floored]
      if (painting) {
        deletePainting(painting)
      }
    }

    emitBlockUpdate(oldBlock, newBlock)
  }

  bot._client.on('update_light', (packet) => {
    const key = columnKeyXZ(packet.chunkX, packet.chunkZ)
    const column = columns[key] || (columns[key] = new Chunk())

    column.loadLight(
      packet.data,
      packet.skyLightMask,
      packet.blockLightMask,
      packet.emptySkyLightMask,
      packet.emptyBlockLightMask
    )
  })

  bot._client.on('map_chunk', (packet) => {
    addColumn({
      x: packet.x,
      z: packet.z,
      bitMap: packet.bitMap,
      heightmaps: packet.heightmaps,
      biomes: packet.biomes,
      skyLightSent: bot.game.dimension === 'overworld',
      groundUp: packet.groundUp,
      data: packet.chunkData
    })

    if (typeof packet.blockEntities !== 'undefined') {
      for (const nbtData of packet.blockEntities) {
        addBlockEntity(nbtData)
      }
    }
  })

  bot._client.on('map_chunk_bulk', (packet) => {
    let offset = 0

    for (const meta of packet.meta) {
      const size = (8192 + (packet.skyLightSent ? 2048 : 0)) *
        onesInShort(meta.bitMap) + // block ids
        2048 * onesInShort(meta.bitMap) + // (two bytes per block id)
        256 // biomes

      addColumn({
        x: meta.x,
        z: meta.z,
        bitMap: meta.bitMap,
        heightmaps: packet.heightmaps,
        skyLightSent: packet.skyLightSent,
        groundUp: true,
        data: packet.data.slice(offset, offset + size)
      })

      offset += size
    }

    assert.strictEqual(offset, packet.data.length)
  })

  bot._client.on('multi_block_change', (packet) => {
    const chunkX = packet.chunkX * 16
    const chunkZ = packet.chunkZ * 16

    // multi block change
    for (const record of packet.records) {
      const blockZ = (record.horizontalPos & 0x0f)
      const blockX = (record.horizontalPos >> 4) & 0x0f

      updateBlockState(
        new Vec3(chunkX + blockX, record.y, chunkZ + blockZ),
        record.blockId
      )
    }
  })

  bot._client.on('block_change', (packet) => {
    updateBlockState(
      new vec3(packet.location),
      packet.type
    )
  })

  bot._client.on('explosion', (packet) => {
    // explosion
    const sourcePoint = vec3(packet)
    for (const { x, y, z } of packet.affectedBlockOffsets) {
      const pt = sourcePoint.offset(x, y, z)
      updateBlockState(pt.floor(), 0)
    }
  })

  bot._client.on('spawn_entity_painting', (packet) => {
    const pos = new vec3(packet.location)
    const painting = new Painting(
      packet.entityId,
      pos,
      packet.title,
      paintingFaceToVec[packet.direction]
    )

    addPainting(painting)
  })

  bot._client.on('entity_destroy', (packet) => {
    // destroy entity
    for (const id of packet.entityIds) {
      const painting = paintingsById[id]

      if (painting) {
        deletePainting(painting)
      }
    }
  })

  bot._client.on('update_sign', (packet) => {
    const pos = new vec3(packet.location)
    const oldBlock = blockAt(pos)

    const prepareString = (i) => {
      let text = packet[`text${i}`]

      if (text === 'null' || text === '') {
        text = '""'
      }

      const json = JSON.parse(text)
      if (json.text) {
        json.text = json.text.replace(/^"|"$/g, '')
      }

      return new ChatMessage(json)
    }

    signs[pos] = [
      prepareString(1),
      prepareString(2),
      prepareString(3),
      prepareString(4)
    ].join('\n')

    emitBlockUpdate(oldBlock, blockAt(pos))
  })

  bot._client.on('tile_entity_data', (packet) => {
    addBlockEntity(packet.nbtData)
  })

  bot.updateSign = (block, text) => {
    const lines = JSON.stringify(text).split('\n')

    if (lines.length > 4) {
      throw new Error('too many lines for sign text')
    }

    for (const line of lines) {
      if (line.length > 15) {
        throw new Error('signs have max line length 15')
      }
    }

    bot._client.write('update_sign', {
      location: block.position,
      text1: lines[0],
      text2: lines[1],
      text3: lines[2],
      text4: lines[3]
    })
  }

  // if we get a respawn packet and the dimension is changed,
  // unload all chunks from memory.
  let dimension
  bot._client.on('login', (packet) => {
    dimension = packet.dimension
  })

  bot._client.on('respawn', (packet) => {
    if (dimension === packet.dimension) {
      return
    }

    dimension = packet.dimension
    columns = {}
  })

  bot.findBlock = findBlock
  bot.canSeeBlock = canSeeBlock
  bot.blockAt = blockAt
  bot._chunkColumn = chunkColumn
  bot._updateBlockState = updateBlockState
  bot._columns = columns
  bot._blockEntities = blockEntities
}

function columnKeyXZ (x, z) {
  return `${x},${z}`
}

function onesInShort (n) {
  const mask = n & 0xffff

  let count = 0
  for (let i = 0; i < 16; ++i) {
    if ((1 << i) & mask) {
      count += 1
    }
  }

  return count
}

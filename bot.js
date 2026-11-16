import makeWASocket, {
  DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState,
  makeCacheableSignalKeyStore, downloadMediaMessage,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import NodeCache from '@cacheable/node-cache'
import qrcode from 'qrcode-terminal'
import pino from 'pino'
import fs from 'fs'
import path from 'path'

const CFG = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf8'))
const logger = pino({ level: 'silent' })
const retryCache = new NodeCache()

const PREFIX = '.'
const jidToNum = j => j?.split('@')[0].split(':')[0]
const isOwner = j => CFG.OWNERS.map(o => String(o).replace(/\D/g, '')).includes(jidToNum(j))

async function isAdmin(sock, jid, participant) {
  if (!jid.endsWith('@g.us')) return isOwner(participant)
  const meta = await sock.groupMetadata(jid).catch(() => null)
  return meta?.participants?.find(p => p.id === participant)?.admin != null || isOwner(participant)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
  const { version } = await fetchLatestBaileysVersion()
  const sock = makeWASocket({
    version, logger,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    msgRetryCounterCache: retryCache,
    markOnlineOnConnect: false,
  })

  sock.ev.process(async (events) => {
    if (events['connection.update']) {
      const { connection, lastDisconnect, qr } = events['connection.update']
      if (qr) {
        console.log('\n[auth] Scan QR or use pairing code:\n')
        qrcode.generate(qr, { small: true })
        if (CFG.PAIRING_NUMBER && !sock.authState.creds.registered) {
          const code = await sock.requestPairingCode(CFG.PAIRING_NUMBER.replace(/\D/g, ''))
          console.log(`[auth] Pairing code: ${code}`)
        }
      }
      if (connection === 'open') console.log('[auth] Connected:', sock.user?.id)
      if (connection === 'close') {
        const code = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output.statusCode : 500
        if (code === DisconnectReason.loggedOut) { console.error('Logged out. Delete baileys_auth_info.'); process.exit(1) }
        setTimeout(startBot, 3000)
      }
    }
    if (events['creds.update']) await saveCreds()

    // welcome / farewell
    if (events['group-participants.update']) {
      const { id, action, participants } = events['group-participants.update']
      if (action === 'add' && CFG.WELCOME)
        await sock.sendMessage(id, { text: `Welcome ${participants.map(p => '@' + jidToNum(p.id)).join(' ')}!`, mentions: participants.map(p => p.id) })
      if (action === 'remove' && CFG.GOODBYE)
        await sock.sendMessage(id, { text: `Goodbye @${participants.map(p => jidToNum(p.id)).join(' @')}`, mentions: participants.map(p => p.id) })
    }

    if (events['messages.upsert']) {
      const upsert = events['messages.upsert']
      if (upsert.type !== 'notify') return
      for (const msg of upsert.messages) {
        if (msg.key.fromMe) continue
        const jid = msg.key.remoteJid
        if (!jid || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) continue
        const sender = msg.key.participant || jid
        const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''
        if (!body.startsWith(PREFIX)) continue

        const [cmdRaw, ...args] = body.slice(PREFIX.length).trim().split(/\s+/)
        const cmd = cmdRaw.toLowerCase()
        const admin = await isAdmin(sock, jid, sender)
        const ctx = { sock, msg, jid, sender, args, admin, reply: t => sock.sendMessage(jid, { text: t }, { quoted: msg }) }

        try { await handleCommand(cmd, ctx) } catch (e) { ctx.reply('Error: ' + e.message) }
      }
    }
  })
  return sock
}

async function handleCommand(cmd, { sock, msg, jid, args, admin, reply }) {
  const isGroup = jid.endsWith('@g.us')

  switch (cmd) {
    case 'menu': {
      reply(`*BUGBOT MENU*\n
${PREFIX}menu — this menu
${PREFIX}ping — latency check
${PREFIX}id — get chat JID
${PREFIX}tag <text> — mention everyone${isGroup ? ' (admin)' : ''}
${PREFIX}kick @user — remove member${isGroup ? ' (admin)' : ''}
${PREFIX}add <number> — add member${isGroup ? ' (admin)' : ''}
${PREFIX}promote/@user · ${PREFIX}demote @user — admin mgmt (admin)
${PREFIX}antilink on/off — delete link posts (admin)
${PREFIX}welcome on/off — join messages (admin)
${PREFIX}mute / ${PREFIX}unlock — group settings (admin)
${PREFIX}bc <text> — broadcast to all chats (owner)
${PREFIX}block <number> / ${PREFIX}unblock <number> (owner)
${PREFIX}pp — set your group pic from quoted image (admin)
${PREFIX}sticker — quoted image -> sticker
${PREFIX}fetch <url> — download media from link
${PREFIX}setname <name> · ${PREFIX}setdesc <text> (admin)
${PREFIX}poll <q> | opt1 | opt2 — create poll
${PREFIX}delete — delete a quoted bot message (admin)`)
      break
    }

    case 'ping': {
      const t = Date.now()
      const s = await sock.sendMessage(jid, { text: 'pong' }, { quoted: msg })
      await sock.sendMessage(jid, { text: `pong (${Date.now() - t}ms)`, edit: s.key })
      break
    }

    case 'id': reply(jid); break

    case 'tag': case 'hidetag': {
      if (!admin) return reply('Admin only.')
      if (!isGroup) return reply('Groups only.')
      const meta = await sock.groupMetadata(jid)
      const mentions = meta.participants.map(p => p.id)
      await sock.sendMessage(jid, { text: args.join(' ') || '\u200B', mentions })
      break
    }

    case 'kick': {
      if (!admin || !isGroup) return reply('Admins only, groups only.')
      const targets = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid
        || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage && [msg.message.extendedTextMessage.contextInfo.participant]
      if (!targets?.length) return reply('Tag or quote someone.')
      await sock.groupParticipantsUpdate(jid, targets, 'remove')
      reply('Done.')
      break
    }

    case 'add': {
      if (!admin || !isGroup) return reply('Admins only, groups only.')
      const num = args[0]?.replace(/\D/g, '') + '@s.whatsapp.net'
      await sock.groupParticipantsUpdate(jid, [num], 'add')
      reply('Done.')
      break
    }

    case 'promote': case 'demote': {
      if (!admin || !isGroup) return reply('Admins only, groups only.')
      const targets = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid
      if (!targets?.length) return reply('Tag someone.')
      await sock.groupParticipantsUpdate(jid, targets, cmd)
      reply('Done.')
      break
    }

    case 'antilink': {
      // handled below via listener flag; toggles stored in memory map
      antilink.set(jid, args[0] === 'on')
      reply(`Anti-link ${args[0] === 'on' ? 'enabled' : 'disabled'} for this chat.`)
      break
    }

    case 'welcome': {
      CFG.WELCOME = args[0] === 'on'
      reply(`Welcome messages: ${CFG.WELCOME ? 'on' : 'off'}`)
      break
    }

    case 'mute': case 'unlock': {
      if (!admin || !isGroup) return reply('Admins only.')
      await sock.groupSettingUpdate(jid, cmd === 'mute' ? 'announcement' : 'not_announcement')
      reply(cmd === 'mute' ? 'Group muted (admins only).' : 'Group unlocked.')
      break
    }

    case 'setname': {
      if (!admin || !isGroup) return reply('Admins only.')
      await sock.groupUpdateSubject(jid, args.join(' '))
      reply('Name updated.')
      break
    }

    case 'setdesc': {
      if (!admin || !isGroup) return reply('Admins only.')
      await sock.groupUpdateDescription(jid, args.join(' '))
      reply('Description updated.')
      break
    }

    case 'bc': {
      if (!isOwner(msg.key.participant || jid)) return reply('Owner only.')
      const chats = (await sock.groupFetchAllParticipating())
      for (const g of Object.keys(chats)) { await sock.sendMessage(g, { text: `[BROADCAST]\n${args.join(' ')}` }); await sleep(1500) }
      reply(`Sent to ${Object.keys(chats).length} groups.`)
      break
    }

    case 'block': case 'unblock': {
      if (!isOwner(msg.key.participant || jid)) return reply('Owner only.')
      const num = args[0]?.replace(/\D/g, '') + '@s.whatsapp.net'
      await sock.updateBlockStatus(num, cmd === 'block' ? 'block' : 'unblock')
      reply('Done.')
      break
    }

    case 'sticker': {
      const q = msg.message?.imageMessage || msg.message?.documentMessage
        || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage
      if (!q) return reply('Send/quote an image.')
      const buf = await downloadMediaMessage({ key: msg.key, message: { imageMessage: q } }, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })
      await sock.sendMessage(jid, { sticker: buf })
      break
    }

    case 'poll': {
      const parts = args.join(' ').split('|').map(s => s.trim()).filter(Boolean)
      if (parts.length < 3) return reply('Format: .poll question | opt1 | opt2')
      await sock.sendMessage(jid, { poll: { name: parts[0], values: parts.slice(1, 13) } })
      break
    }

    case 'delete': {
      if (!admin) return reply('Admin only.')
      const qk = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
      if (!qk) return reply('Quote a message.')
      await sock.sendMessage(jid, { delete: msg.message.extendedTextMessage.contextInfo.quotedMessage.stubKey || msg.message.extendedTextMessage.contextInfo.stanzaId ? { remoteJid: jid, fromMe: false, id: msg.message.extendedTextMessage.contextInfo.stanzaId, participant: msg.message.extendedTextMessage.contextInfo.participant } : undefined })
      break
    }

    default: reply(`Unknown command. Try ${PREFIX}menu`)
  }
}

// anti-link enforcement
const antilink = new Map()
const LINK_RE = /(https?:\/\/|wa\.me\/|chat\.whatsapp\.com\/)/i

// wrap startBot to inject antilink check
const _start = startBot
async function startBotWrapped() {
  const sock = await _start()
  sock.ev.on('messages.upsert', async ({ type, messages }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      if (msg.key.fromMe) continue
      const jid = msg.key.remoteJid
      if (!antilink.get(jid)) continue
      const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''
      if (LINK_RE.test(body)) {
        await sock.sendMessage(jid, { delete: msg.key })
        await sock.groupParticipantsUpdate(jid, [msg.key.participant], 'remove').catch(() => {})
      }
    }
  })
  return sock
}

startBotWrapped().catch(e => { console.error(e); process.exit(1) })

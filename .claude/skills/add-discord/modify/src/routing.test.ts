import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, getAllChats, storeChatMetadata } from './db.js';
import { getAvailableGroups, _setRegisteredGroups } from './index.js';

beforeEach(() => {
  _initTestDatabase();
  _setRegisteredGroups({});
});

// --- JID ownership patterns ---

describe('JID ownership patterns', () => {
  // These test the patterns that will become ownsJid() on the Channel interface

  it('WhatsApp group JID: ends with @g.us', () => {
    const jid = '12345678@g.us';
    expect(jid.endsWith('@g.us')).toBe(true);
  });

  it('WhatsApp DM JID: ends with @s.whatsapp.net', () => {
    const jid = '12345678@s.whatsapp.net';
    expect(jid.endsWith('@s.whatsapp.net')).toBe(true);
  });

  it('Discord JID: starts with dc:', () => {
    const jid = 'dc:1234567890123456';
    expect(jid.startsWith('dc:')).toBe(true);
  });

  it('unknown JID format: does not match any channel pattern', () => {
    const jid = 'unknown:12345';
    expect(jid.endsWith('@g.us')).toBe(false);
    expect(jid.endsWith('@s.whatsapp.net')).toBe(false);
    expect(jid.startsWith('dc:')).toBe(false);
  });
});

// --- getAvailableGroups ---

describe('getAvailableGroups', () => {
  it('returns @g.us and dc: JIDs, excludes DMs', () => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:01.000Z', 'Group 1');
    storeChatMetadata('user@s.whatsapp.net', '2024-01-01T00:00:02.000Z', 'User DM');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:03.000Z', 'Group 2');
    storeChatMetadata('dc:1234567890123456', '2024-01-01T00:00:04.000Z', 'Discord Channel');

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.jid)).toContain('group1@g.us');
    expect(groups.map((g) => g.jid)).toContain('group2@g.us');
    expect(groups.map((g) => g.jid)).toContain('dc:1234567890123456');
    expect(groups.map((g) => g.jid)).not.toContain('user@s.whatsapp.net');
  });

  it('excludes __group_sync__ sentinel', () => {
    storeChatMetadata('__group_sync__', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Group');

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('group@g.us');
  });

  it('marks registered groups correctly for WhatsApp and Discord', () => {
    storeChatMetadata('reg@g.us', '2024-01-01T00:00:01.000Z', 'WA Registered');
    storeChatMetadata('unreg@g.us', '2024-01-01T00:00:02.000Z', 'WA Unregistered');
    storeChatMetadata('dc:1234567890123456', '2024-01-01T00:00:03.000Z', 'DC Registered');
    storeChatMetadata('dc:9999999999999999', '2024-01-01T00:00:04.000Z', 'DC Unregistered');

    _setRegisteredGroups({
      'reg@g.us': {
        name: 'WA Registered',
        folder: 'wa-registered',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
      'dc:1234567890123456': {
        name: 'DC Registered',
        folder: 'dc-registered',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    const groups = getAvailableGroups();
    const waReg = groups.find((g) => g.jid === 'reg@g.us');
    const waUnreg = groups.find((g) => g.jid === 'unreg@g.us');
    const dcReg = groups.find((g) => g.jid === 'dc:1234567890123456');
    const dcUnreg = groups.find((g) => g.jid === 'dc:9999999999999999');

    expect(waReg?.isRegistered).toBe(true);
    expect(waUnreg?.isRegistered).toBe(false);
    expect(dcReg?.isRegistered).toBe(true);
    expect(dcUnreg?.isRegistered).toBe(false);
  });

  it('returns groups ordered by most recent activity', () => {
    storeChatMetadata('old@g.us', '2024-01-01T00:00:01.000Z', 'Old');
    storeChatMetadata('new@g.us', '2024-01-01T00:00:05.000Z', 'New');
    storeChatMetadata('mid@g.us', '2024-01-01T00:00:03.000Z', 'Mid');

    const groups = getAvailableGroups();
    expect(groups[0].jid).toBe('new@g.us');
    expect(groups[1].jid).toBe('mid@g.us');
    expect(groups[2].jid).toBe('old@g.us');
  });

  it('returns empty array when no chats exist', () => {
    const groups = getAvailableGroups();
    expect(groups).toHaveLength(0);
  });

  it('mixes WhatsApp and Discord chats ordered by activity', () => {
    storeChatMetadata('wa@g.us', '2024-01-01T00:00:01.000Z', 'WhatsApp');
    storeChatMetadata('dc:555', '2024-01-01T00:00:03.000Z', 'Discord');
    storeChatMetadata('wa2@g.us', '2024-01-01T00:00:02.000Z', 'WhatsApp 2');

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(3);
    expect(groups[0].jid).toBe('dc:555');
    expect(groups[1].jid).toBe('wa2@g.us');
    expect(groups[2].jid).toBe('wa@g.us');
  });
});

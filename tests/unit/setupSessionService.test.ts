import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import * as setupSessionService from '../../src/server/services/setupSessionService';
import * as storage from '../../src/server/services/storageService';

const createdSessionIds: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdSessionIds.map((sessionId) =>
      fs.unlink(storage.setupSessionJsonPath(sessionId)).catch(() => undefined)
    )
  );
  createdSessionIds.length = 0;
});

describe('setupSessionService', () => {
  it('creates a setup session without calling a model when initial message is empty', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    expect(result.session.status).toBe('active');
    expect(result.session.revision).toBe(1);
    expect(result.session.draft.confirmed).toEqual([]);
  });

  it('lists setup sessions with the latest session first', async () => {
    const first = await setupSessionService.createSetupSession({});
    const second = await setupSessionService.createSetupSession({});
    createdSessionIds.push(first.sessionId, second.sessionId);

    const sessions = await setupSessionService.listSetupSessions();

    expect(sessions.map((session) => session.sessionId)).toEqual(
      expect.arrayContaining([first.sessionId, second.sessionId])
    );
    expect(sessions.find((session) => session.sessionId === first.sessionId)).toMatchObject({
      status: 'active',
      messageCount: 0,
    });
  });

  it('rejects stale draft revisions', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    await expect(
      setupSessionService.updateSetupDraft(result.sessionId, {
        draft: result.session.draft,
        revision: 0,
      })
    ).rejects.toMatchObject({
      code: 'revision_conflict',
      status: 409,
    });
  });

  it('records manual edit locks when updating a setup draft', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    const updated = await setupSessionService.updateSetupDraft(result.sessionId, {
      draft: {
        ...result.session.draft,
        coreConcept: '手動で直した核',
      },
      revision: result.session.revision,
      manualEditPaths: ['draft.coreConcept'],
    });

    expect(updated.session.locks).toContainEqual(
      expect.objectContaining({
        path: 'draft.coreConcept',
        reason: 'manual_edit',
      })
    );
  });

  it('normalizes invalid setup session ids to a 400 service error', async () => {
    await expect(setupSessionService.getSetupSession('../escape')).rejects.toMatchObject({
      code: 'invalid_setup_id',
      status: 400,
    });
  });

  it('does not expose raw model output when setup chat JSON cannot be parsed', () => {
    const rawOutput = '{"visibleReply":"読めてはいけない", "draftPatch":';
    const parsed = setupSessionService.parseChatResult(rawOutput);

    expect(parsed.visibleReply).not.toContain(rawOutput);
    expect(parsed.visibleReply).not.toContain('読めてはいけない');
    expect(parsed.draftPatch).toBeNull();
    expect(parsed.suggestedActions).toEqual([
      {
        label: 'もう一度整理',
        message: '直前の相談内容をもう一度整理してください。',
      },
    ]);
  });
});

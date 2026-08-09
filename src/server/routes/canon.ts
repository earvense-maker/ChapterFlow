import { Router } from 'express';
import * as storage from '../services/storageService.js';
import * as creativeContractService from '../services/creativeContractService.js';
import * as latentCanonService from '../services/latentCanonService.js';
import * as generationService from '../services/generationService.js';
import { withProjectWriteLock } from '../services/projectLock.js';
import { adapterMap } from '../adapters/index.js';
import type {
  CanonPatchBody,
  CanonScope,
  CreativeContract,
  CreativeContractItemInput,
  CreativeContractPutBody,
  LatentCanonItem,
  LatentCanonStore,
  Project,
  RoleplaySession,
} from '../types/index.js';

const router = Router();

// ============================================================
// 創作契約
// ============================================================

router.get('/projects/:id/creative-contract', async (req, res, next) => {
  try {
    const contract = await creativeContractService.readCreativeContractOrEmpty(req.params.id);
    res.json(contract);
  } catch (err) {
    next(err);
  }
});

router.put('/projects/:id/creative-contract', async (req, res, next) => {
  try {
    const project = await requireProject(req.params.id);
    const body = parseCreativeContractPut(req.body);
    // NOTE: revision検査と保存をproject write lock内で行う（レビュー指摘 P1）。
    // LLM検査を含む保存の間に別リクエストが同じrevisionで保存しても、最後の保存が
    // 前の変更を上書きしない。
    const saved = await withProjectWriteLock(req.params.id, async () => {
      const current = await creativeContractService.readCreativeContractOrEmpty(req.params.id);
      if (body.revision !== current.revision) {
        const conflict = new Error(
          '作品の約束が別の画面で更新されています。最新の内容を取得してから再度保存してください。'
        ) as Error & { status?: number; code?: string; retryable?: boolean };
        conflict.status = 409;
        conflict.code = 'contract_revision_conflict';
        conflict.retryable = true;
        throw conflict;
      }

      // NOTE: semantic conflict検査（設計書 5.2）。初回PUTは409+conflictFingerprint、
      // 同一revisionと確認fingerprint付き再PUTだけが保存される。
      const items = creativeContractService.validateContractItems(body.items, {
        enforceRenderLimit: true,
      });
      const draft: CreativeContract = {
        ...current,
        items,
        verificationMode: body.verificationMode ?? current.verificationMode,
      };

      const conflicts = await creativeContractService.detectHardContractConflicts({
        project,
        adapter: adapterMap[project.activeModelProvider],
        items,
      });
      if (conflicts.length > 0) {
        const conflictFingerprint =
          creativeContractService.computeConflictFingerprint(conflicts);
        if (body.confirmConflictFingerprint !== conflictFingerprint) {
          const conflict = new Error(
            '強く守る約束の間に、意味的に両立しない組み合わせが見つかりました。'
          ) as Error & {
            status?: number;
            code?: string;
            retryable?: boolean;
            revision?: number;
            conflicts?: unknown;
            conflictFingerprint?: string;
          };
          conflict.status = 409;
          conflict.code = 'contract_conflict';
          conflict.retryable = false;
          conflict.revision = current.revision;
          conflict.conflicts = conflicts;
          conflict.conflictFingerprint = conflictFingerprint;
          throw conflict;
        }
      }

      return creativeContractService.saveCreativeContractWithNextRevision(draft);
    });
    res.json(saved);
  } catch (err) {
    if (err instanceof creativeContractService.CreativeContractValidationError) {
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code, retryable: false });
    }
    const conflict = err as Error & {
      status?: number;
      code?: string;
      retryable?: boolean;
      revision?: number;
      conflicts?: unknown;
      conflictFingerprint?: string;
    };
    if (conflict.status === 409 && conflict.code === 'contract_conflict') {
      return res.status(409).json({
        error: conflict.message,
        code: conflict.code,
        retryable: conflict.retryable,
        revision: conflict.revision,
        conflicts: conflict.conflicts,
        conflictFingerprint: conflict.conflictFingerprint,
      });
    }
    if (conflict.status === 409 && conflict.code === 'contract_revision_conflict') {
      return res.status(409).json({
        error: conflict.message,
        code: conflict.code,
        retryable: true,
      });
    }
    next(err);
  }
});

// ============================================================
// 潜在設定
// ============================================================

// NOTE: shielded時は未公開項目の件数・カテゴリだけを返す（設計書 7.2）。
router.get('/projects/:id/canon-summary', async (req, res, next) => {
  try {
    const [store, state] = await Promise.all([
      latentCanonService.readLatentCanonStore(req.params.id),
      storage.readState(req.params.id),
    ]);
    const spoilerMode = state?.uiState?.canonSpoilerMode === 'visible' ? 'visible' : 'shielded';
    res.json(latentCanonService.buildCanonSummary(store, spoilerMode));
  } catch (err) {
    next(err);
  }
});

// NOTE: 潜在設定本文の取得は明示操作（design書 7.2）。revisionは要求しない。
router.post('/projects/:id/canon/reveal', async (req, res, next) => {
  try {
    const canonId = asString((req.body as { canonId?: unknown })?.canonId);
    if (!canonId) {
      return res.status(400).json({ error: 'canonId が必要です。', code: 'invalid_request' });
    }
    const store = await latentCanonService.readLatentCanonStore(req.params.id);
    const item = store.items.find((candidate) => candidate.canonId === canonId);
    if (!item) {
      return res.status(404).json({ error: '設定が見つかりません。', code: 'canon_not_found' });
    }
    res.json(item);
  } catch (err) {
    next(err);
  }
});

router.get('/projects/:id/canon-conflicts', async (req, res, next) => {
  try {
    const store = await latentCanonService.readLatentCanonStore(req.params.id);
    res.json({
      revision: store.revision,
      conflicts: store.pendingConflicts,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/projects/:id/canon-conflicts/:conflictId/resolve', async (req, res, next) => {
  try {
    const status = asString((req.body as { status?: unknown })?.status);
    if (status !== 'resolved' && status !== 'exception-accepted' && status !== 'dismissed') {
      return res.status(400).json({
        error: 'status は resolved / exception-accepted / dismissed のいずれかです。',
        code: 'invalid_conflict_status',
      });
    }
    const body = req.body as { revision?: unknown };
    if (typeof body?.revision !== 'number') {
      return res.status(400).json({ error: 'revision が必要です。', code: 'invalid_request' });
    }

    // NOTE: 契約・canonの二書き込みをproject write lock内で原子的に行う（レビュー指摘 P1）。
    const saved = await withProjectWriteLock(req.params.id, async () => {
      const store = await latentCanonService.readLatentCanonStore(req.params.id);
      if (body.revision !== store.revision) {
        const conflict = new Error(
          '設定が別の画面で更新されています。最新の内容を取得してから再度実行してください。'
        ) as Error & { status?: number; code?: string; retryable?: boolean };
        conflict.status = 409;
        conflict.code = 'canon_revision_conflict';
        conflict.retryable = true;
        throw conflict;
      }
      const conflict = store.pendingConflicts.find(
        (candidate) => candidate.conflictId === req.params.conflictId
      );
      if (!conflict) {
        const notFound = new Error('競合が見つかりません。') as Error & {
          status?: number;
          code?: string;
        };
        notFound.status = 404;
        notFound.code = 'conflict_not_found';
        throw notFound;
      }
      let nextStore = store;
      if (status === 'exception-accepted') {
        if (!conflict.contractId || !conflict.generationId) {
          const invalid = new Error('hard契約の競合だけが例外として残せます。') as Error & {
            status?: number;
            code?: string;
          };
          invalid.status = 400;
          invalid.code = 'invalid_exception_target';
          throw invalid;
        }
        // 矛盾観測のcanon patchをderivation journalから再構築する（設計書 6.3）。
        // 観測が見つからない場合は解決せず400を返す（例外だけが残る・無言で解決済みに
        // なるのを防ぐ・レビュー指摘 P1）。
        const { readDerivations, deriveCanonPatchForException } = await import(
          '../services/acceptedNarrativeDerivationService.js'
        );
        const derivations = await readDerivations(req.params.id);
        const derivation = derivations.find(
          (item) => item.generationId === conflict.generationId
        );
        const conflictingObservation = (derivation?.observations ?? []).find(
          (observation) =>
            observation.kind === 'canon' &&
            observation.conflict?.kind === 'hard-contract' &&
            observation.conflict.targetContractId === conflict.contractId
        );
        if (!conflictingObservation) {
          const missing = new Error(
            'この競合の対象となった観測が見つかりません。再抽出してから再試行してください。'
          ) as Error & { status?: number; code?: string };
          missing.status = 400;
          missing.code = 'exception_observation_missing';
          throw missing;
        }

        // NOTE: 例外の参照整合性（契約存在・採用済みgeneration）は保存前に検証する
        // （レビュー指摘 P1）。検証失敗なら契約もcanonも保存されない。
        const contract = await creativeContractService.readCreativeContractOrEmpty(req.params.id);
        const exceptionId = await import('../utils/id.js').then(({ generateTimestampId }) =>
          generateTimestampId('ex')
        );
        const exception = {
          exceptionId,
          contractId: conflict.contractId,
          generationId: conflict.generationId,
          evidenceExcerpt: conflict.evidenceExcerpt,
          createdAt: new Date().toISOString(),
        };
        const nextContract = {
          ...contract,
          exceptions: [...contract.exceptions, exception],
        };
        await creativeContractService.validateContractExceptions(req.params.id, nextContract);

        // 保存順: canon → 契約。canon保存に失敗したら契約は保存されず、
        // 「例外だけが残る」状態を作らない。契約保存失敗時は競合をpendingのまま残す。
        const generation = await storage.findGenerationRecord(req.params.id, conflict.generationId);
        const patch = deriveCanonPatchForException(conflictingObservation);
        const applied = latentCanonService.applyCanonPatchUnlocked(store, patch, {
          generationId: conflict.generationId,
          sceneId: generation?.sceneId ?? '',
        });
        const resolved = latentCanonService.resolveConflictUnlocked(
          applied.store,
          conflict.conflictId,
          status
        );
        const savedCanon = await latentCanonService.saveLatentCanonStoreWithNextRevision(resolved);
        await creativeContractService.saveCreativeContractWithNextRevision(nextContract);
        return savedCanon;
      }
      const resolved = latentCanonService.resolveConflictUnlocked(
        nextStore,
        conflict.conflictId,
        status
      );
      return latentCanonService.saveLatentCanonStoreWithNextRevision(resolved);
    });
    res.json(latentCanonService.buildCanonSummary(saved, 'shielded'));
  } catch (err) {
    const known = err as Error & { status?: number; code?: string; retryable?: boolean };
    if (known.status === 404) {
      return res.status(404).json({ error: known.message, code: known.code });
    }
    if (known.status === 409) {
      return res.status(409).json({ error: known.message, code: known.code, retryable: true });
    }
    if (known.status === 400) {
      return res.status(400).json({ error: known.message, code: known.code });
    }
    if (err instanceof creativeContractService.CreativeContractValidationError) {
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code, retryable: false });
    }
    next(err);
  }
});

router.patch('/projects/:id/canon/:canonId', async (req, res, next) => {
  try {
    const body = req.body as CanonPatchBody;
    if (typeof body?.revision !== 'number') {
      return res.status(400).json({ error: 'revision が必要です。', code: 'invalid_request' });
    }
    // NOTE: revision検査と保存をproject write lock内で行う（レビュー指摘 P1）。
    const saved = await withProjectWriteLock(req.params.id, async () => {
      const store = await latentCanonService.readLatentCanonStore(req.params.id);
      if (body.revision !== store.revision) {
        const conflict = new Error(
          '設定が別の画面で更新されています。最新の内容を取得してから再度保存してください。'
        ) as Error & { status?: number; code?: string; retryable?: boolean };
        conflict.status = 409;
        conflict.code = 'canon_revision_conflict';
        conflict.retryable = true;
        throw conflict;
      }
      const item = store.items.find((candidate) => candidate.canonId === req.params.canonId);
      if (!item) {
        const notFound = new Error('設定が見つかりません。') as Error & {
          status?: number;
          code?: string;
        };
        notFound.status = 404;
        notFound.code = 'canon_not_found';
        throw notFound;
      }
      const next = latentCanonService.updateCanonItemUnlocked(store, item.canonId, {
        statement: asOptionalString(body.statement),
        scope: asOptionalScope(body.scope),
        epistemicStatus: asOptionalEpistemicStatus(body.epistemicStatus),
        knownBy: body.knownBy,
        explicitlyUnknownBy: body.explicitlyUnknownBy,
      });
      return latentCanonService.saveLatentCanonStoreWithNextRevision(next);
    });
    const [state] = await Promise.all([storage.readState(req.params.id)]);
    const spoilerMode = state?.uiState?.canonSpoilerMode === 'visible' ? 'visible' : 'shielded';
    res.json(latentCanonService.buildCanonSummary(saved, spoilerMode));
  } catch (err) {
    const known = err as Error & { status?: number; code?: string };
    if (known.status === 404) {
      return res.status(404).json({ error: known.message, code: known.code });
    }
    if (known.status === 409) {
      return res
        .status(409)
        .json({ error: known.message, code: known.code, retryable: true });
    }
    next(err);
  }
});

router.post('/projects/:id/canon/:canonId/lock', async (req, res, next) => {
  try {
    const body = req.body as { revision?: unknown; locked?: unknown };
    if (typeof body?.revision !== 'number') {
      return res.status(400).json({ error: 'revision が必要です。', code: 'invalid_request' });
    }
    const saved = await withProjectWriteLock(req.params.id, async () => {
      const store = await latentCanonService.readLatentCanonStore(req.params.id);
      if (body.revision !== store.revision) {
        const conflict = new Error(
          '設定が別の画面で更新されています。最新の内容を取得してから再度実行してください。'
        ) as Error & { status?: number; code?: string; retryable?: boolean };
        conflict.status = 409;
        conflict.code = 'canon_revision_conflict';
        conflict.retryable = true;
        throw conflict;
      }
      // NOTE: 存在しない項目へのno-opでrevisionを進めない（レビュー指摘 P2）。
      if (!store.items.some((item) => item.canonId === req.params.canonId)) {
        const notFound = new Error('設定が見つかりません。') as Error & {
          status?: number;
          code?: string;
        };
        notFound.status = 404;
        notFound.code = 'canon_not_found';
        throw notFound;
      }
      const next = latentCanonService.setCanonLockUnlocked(
        store,
        req.params.canonId,
        body.locked === true
      );
      return latentCanonService.saveLatentCanonStoreWithNextRevision(next);
    });
    res.json(saved);
  } catch (err) {
    const known = err as Error & { status?: number; code?: string };
    if (known.status === 404) {
      return res.status(404).json({ error: known.message, code: known.code });
    }
    if (known.status === 409) {
      return res
        .status(409)
        .json({ error: known.message, code: known.code, retryable: true });
    }
    next(err);
  }
});

router.post('/projects/:id/canon/:canonId/retire', async (req, res, next) => {
  try {
    const body = req.body as { revision?: unknown; reason?: unknown };
    if (typeof body?.revision !== 'number') {
      return res.status(400).json({ error: 'revision が必要です。', code: 'invalid_request' });
    }
    const reason = asString(body.reason);
    if (reason !== 'unused' && reason !== 'manual' && reason !== 'replaced') {
      return res.status(400).json({
        error: 'reason は unused / manual / replaced のいずれかです。',
        code: 'invalid_retire_reason',
      });
    }
    const saved = await withProjectWriteLock(req.params.id, async () => {
      const store = await latentCanonService.readLatentCanonStore(req.params.id);
      if (body.revision !== store.revision) {
        const conflict = new Error(
          '設定が別の画面で更新されています。最新の内容を取得してから再度実行してください。'
        ) as Error & { status?: number; code?: string; retryable?: boolean };
        conflict.status = 409;
        conflict.code = 'canon_revision_conflict';
        conflict.retryable = true;
        throw conflict;
      }
      // NOTE: 存在しない項目へのno-opでrevisionを進めない（レビュー指摘 P2）。
      if (!store.items.some((item) => item.canonId === req.params.canonId)) {
        const notFound = new Error('設定が見つかりません。') as Error & {
          status?: number;
          code?: string;
        };
        notFound.status = 404;
        notFound.code = 'canon_not_found';
        throw notFound;
      }
      const next = latentCanonService.retireCanonItemUnlocked(
        store,
        req.params.canonId,
        reason
      );
      return latentCanonService.saveLatentCanonStoreWithNextRevision(next);
    });
    res.json(saved);
  } catch (err) {
    const known = err as Error & { status?: number; code?: string };
    if (known.status === 404) {
      return res.status(404).json({ error: known.message, code: known.code });
    }
    if (known.status === 409) {
      return res
        .status(409)
        .json({ error: known.message, code: known.code, retryable: true });
    }
    next(err);
  }
});

// NOTE: 手動退役・競合退役の取り消し（設計書 5.3・レビュー指摘 P2）。
// statusBeforeRetiredを持たない項目は400で拒否する。
router.post('/projects/:id/canon/:canonId/restore', async (req, res, next) => {
  try {
    const body = req.body as { revision?: unknown };
    if (typeof body?.revision !== 'number') {
      return res.status(400).json({ error: 'revision が必要です。', code: 'invalid_request' });
    }
    const saved = await withProjectWriteLock(req.params.id, async () => {
      const store = await latentCanonService.readLatentCanonStore(req.params.id);
      if (body.revision !== store.revision) {
        const conflict = new Error(
          '設定が別の画面で更新されています。最新の内容を取得してから再度実行してください。'
        ) as Error & { status?: number; code?: string; retryable?: boolean };
        conflict.status = 409;
        conflict.code = 'canon_revision_conflict';
        conflict.retryable = true;
        throw conflict;
      }
      const item = store.items.find((candidate) => candidate.canonId === req.params.canonId);
      if (!item) {
        const notFound = new Error('設定が見つかりません。') as Error & {
          status?: number;
          code?: string;
        };
        notFound.status = 404;
        notFound.code = 'canon_not_found';
        throw notFound;
      }
      if (item.status !== 'retired' || !item.statusBeforeRetired) {
        const invalid = new Error(
          '退役した設定だけを元の状態へ戻せます。'
        ) as Error & { status?: number; code?: string };
        invalid.status = 400;
        invalid.code = 'canon_not_restorable';
        throw invalid;
      }
      const next = latentCanonService.restoreRetiredCanonItemUnlocked(
        store,
        req.params.canonId
      );
      return latentCanonService.saveLatentCanonStoreWithNextRevision(next);
    });
    res.json(saved);
  } catch (err) {
    const known = err as Error & { status?: number; code?: string };
    if (known.status === 404) {
      return res.status(404).json({ error: known.message, code: known.code });
    }
    if (known.status === 409) {
      return res
        .status(409)
        .json({ error: known.message, code: known.code, retryable: true });
    }
    if (known.status === 400) {
      return res.status(400).json({ error: known.message, code: known.code });
    }
    next(err);
  }
});

// NOTE: 未反映の採用本文をStoryState/canonへ再適用する（設計書 7.2）。キャッシュ済み
// derivationがあればモデルを再呼び出ししない。
router.post('/projects/:id/canon/reextract', async (req, res, next) => {
  try {
    const state = await generationService.refreshStoryState(req.params.id);
    res.json(state);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// ロールプレイ session canon（設計書 8.2・8.3）
// ============================================================

// NOTE: opaqueなcanonId、scope、非ネタバレlabelだけを返す。statement/excerptは返さない。
router.get('/projects/:id/roleplay/sessions/:sessionId/canon-summary', async (req, res, next) => {
  try {
    const session = await storage.readRoleplaySession(req.params.id, req.params.sessionId);
    if (!session) {
      return res.status(404).json({ error: 'セッションが見つかりません。', code: 'session_not_found' });
    }
    res.json(latentCanonService.buildSessionCanonSummary(session.sessionCanon ?? []));
  } catch (err) {
    next(err);
  }
});

// NOTE: 明示操作で対象1件のstatementとevidence previewだけを返す（設計書 7.2）。
router.post('/projects/:id/roleplay/sessions/:sessionId/canon/:canonId/reveal', async (req, res, next) => {
  try {
    const session = await storage.readRoleplaySession(req.params.id, req.params.sessionId);
    if (!session) {
      return res.status(404).json({ error: 'セッションが見つかりません。', code: 'session_not_found' });
    }
    const item = (session.sessionCanon ?? []).find(
      (candidate) => candidate.canonId === req.params.canonId
    );
    if (!item) {
      return res.status(404).json({ error: '設定が見つかりません。', code: 'canon_not_found' });
    }
    res.json(item);
  } catch (err) {
    next(err);
  }
});

// NOTE: session canonを作品の潜在設定へ1件ずつ明示昇格する（設計書 8.3）。
// 昇格時は必須excerptを持つ roleplay-promotion evidenceへ変換し、元sessionの削除・
// アーカイブ後も根拠を表示できるようにする。replaceは旧項目を退役させて履歴を残し、
// coexistは既存項目へのmerge（再実行で重複しない・レビュー指摘 P2）。
router.post('/projects/:id/roleplay/sessions/:sessionId/canon/:canonId/promote', async (req, res, next) => {
  try {
    const project = await requireProject(req.params.id);
    const body = req.body as { projectRevision?: unknown; mode?: unknown };
    if (typeof body?.projectRevision !== 'number') {
      return res.status(400).json({ error: 'projectRevision が必要です。', code: 'invalid_request' });
    }
    const mode = asString(body.mode) === 'replace' ? 'replace' : 'coexist';

    const saved = await withProjectWriteLock(req.params.id, async () => {
      const store = await latentCanonService.readLatentCanonStore(req.params.id);
      if (body.projectRevision !== store.revision) {
        const conflict = new Error(
          '作品の設定が別の画面で更新されています。最新の内容を取得してから再度実行してください。'
        ) as Error & { status?: number; code?: string; retryable?: boolean };
        conflict.status = 409;
        conflict.code = 'canon_revision_conflict';
        conflict.retryable = true;
        throw conflict;
      }
      const session = await storage.readRoleplaySession(req.params.id, req.params.sessionId);
      if (!session) {
        const notFound = new Error('セッションが見つかりません。') as Error & {
          status?: number;
          code?: string;
        };
        notFound.status = 404;
        notFound.code = 'session_not_found';
        throw notFound;
      }
      const item = (session.sessionCanon ?? []).find(
        (candidate) => candidate.canonId === req.params.canonId
      );
      if (!item) {
        const notFound = new Error('設定が見つかりません。') as Error & {
          status?: number;
          code?: string;
        };
        notFound.status = 404;
        notFound.code = 'canon_not_found';
        throw notFound;
      }
      // NOTE: 冪等性（レビュー指摘 P1）。昇格済み（promotedToProjectAtあり）の項目への
      // 再実行は何も変更せず、現在の作品側ストアをそのまま返す。coexistのevidence再追加や
      // replaceの置換チェーン増加を防ぐ。
      if (item.promotedToProjectAt) {
        return store;
      }

      const now = new Date().toISOString();
      const existingMatch = latentCanonService.findMergeCandidate(store.items, {
        operation: 'upsert',
        scope: item.scope,
        subjectCharacterIds: item.subjectCharacterIds,
        statement: item.statement,
        epistemicStatus: item.epistemicStatus,
        disclosure: 'revealed',
        evidenceExcerpt: item.evidence[0]?.excerpt ?? '',
      });

      let nextStore: LatentCanonStore;
      if (mode === 'replace' && existingMatch) {
        // NOTE: replaceは既存項目を物理削除せず退役させ、置換元のevidence履歴を残す。
        const superseded = latentCanonService.retireCanonItemUnlocked(
          store,
          existingMatch.canonId,
          'replaced'
        );
        const promoted: LatentCanonItem = {
          canonId: generateCanonId(),
          scope: item.scope,
          ...(item.subjectCharacterIds ? { subjectCharacterIds: item.subjectCharacterIds } : {}),
          statement: item.statement,
          status: 'revealed',
          baseStatusWithoutEvidence: 'retired',
          epistemicStatus: item.epistemicStatus,
          ...(item.knownBy ? { knownBy: item.knownBy } : {}),
          ...(item.explicitlyUnknownBy ? { explicitlyUnknownBy: item.explicitlyUnknownBy } : {}),
          source: 'roleplay',
          manualLock: false,
          evidence: [buildPromotionEvidence(item, session.sessionId, now)],
          supersedesCanonId: existingMatch.canonId,
          createdAt: now,
          updatedAt: now,
        };
        nextStore = { ...superseded, items: [...superseded.items, promoted], updatedAt: now };
      } else if (existingMatch) {
        // NOTE: coexistは既存項目にroleplay-promotion evidenceを追記してmergeする。
        // 再実行しても新IDを発行せず重複しない。session保存失敗後の再試行でも、
        // 同じsessionからのroleplay-promotion evidenceが既にあれば追加しない。
        const hasPromotionFromSession = existingMatch.evidence.some(
          (evidence) =>
            evidence.kind === 'roleplay-promotion' && evidence.sessionId === session.sessionId
        );
        nextStore = {
          ...store,
          items: store.items.map((candidate) =>
            candidate.canonId === existingMatch.canonId
              ? {
                  ...candidate,
                  status: 'revealed' as const,
                  evidence: hasPromotionFromSession
                    ? candidate.evidence
                    : [...candidate.evidence, buildPromotionEvidence(item, session.sessionId, now)].slice(-20),
                  updatedAt: now,
                }
              : candidate
          ),
          updatedAt: now,
        };
      } else {
        const promoted: LatentCanonItem = {
          canonId: generateCanonId(),
          scope: item.scope,
          ...(item.subjectCharacterIds ? { subjectCharacterIds: item.subjectCharacterIds } : {}),
          statement: item.statement,
          status: 'revealed',
          baseStatusWithoutEvidence: 'retired',
          epistemicStatus: item.epistemicStatus,
          ...(item.knownBy ? { knownBy: item.knownBy } : {}),
          ...(item.explicitlyUnknownBy ? { explicitlyUnknownBy: item.explicitlyUnknownBy } : {}),
          source: 'roleplay',
          manualLock: false,
          evidence: [buildPromotionEvidence(item, session.sessionId, now)],
          createdAt: now,
          updatedAt: now,
        };
        nextStore = { ...store, items: [...store.items, promoted], updatedAt: now };
      }

      // NOTE: 保存順はcanon → session（レビュー指摘 P1）。canon保存に失敗したらsession側に
      // 「昇格済み」を記録しない。session保存失敗時は作品側に存在するが昇格マークが無い
      // 状態になるが、再実行は冪等ガードではなくexistingMatchへのmergeで回復する。
      const savedCanon = await latentCanonService.saveLatentCanonStoreWithNextRevision(nextStore);
      const nextSession: RoleplaySession = {
        ...session,
        sessionCanon: (session.sessionCanon ?? []).map((candidate) =>
          candidate.canonId === item.canonId
            ? { ...candidate, promotedToProjectAt: now }
            : candidate
        ),
        updatedAt: now,
      };
      await storage.writeRoleplaySession(nextSession);
      return savedCanon;
    });
    const [state] = await Promise.all([storage.readState(req.params.id)]);
    const spoilerMode = state?.uiState?.canonSpoilerMode === 'visible' ? 'visible' : 'shielded';
    res.json({
      project: project.projectId,
      canonSummary: latentCanonService.buildCanonSummary(saved, spoilerMode),
    });
  } catch (err) {
    const known = err as Error & { status?: number; code?: string };
    if (known.status === 404) {
      return res.status(404).json({ error: known.message, code: known.code });
    }
    if (known.status === 409) {
      return res
        .status(409)
        .json({ error: known.message, code: known.code, retryable: true });
    }
    next(err);
  }
});

// NOTE: 昇格用のroleplay-promotion evidence。excerptを必須でコピーし、元sessionを
// 再読込しなくても根拠を表示できる（設計書 8.3）。
function buildPromotionEvidence(
  item: LatentCanonItem,
  sessionId: string,
  now: string
): LatentCanonItem['evidence'][number] {
  return {
    kind: 'roleplay-promotion',
    disclosure: 'revealed',
    ...(sessionId ? { sessionId } : {}),
    ...(item.evidence[0]?.messageId ? { messageId: item.evidence[0].messageId } : {}),
    excerpt: (item.evidence[0]?.excerpt ?? item.statement).slice(0, 160),
    createdAt: now,
  };
}

// ============================================================
// ヘルパー
// ============================================================

async function requireProject(projectId: string): Promise<Project> {
  const project = await storage.readProject(projectId);
  if (!project) {
    const error = new Error('Project not found') as Error & { status?: number };
    error.status = 404;
    throw error;
  }
  return project;
}

function parseCreativeContractPut(value: unknown): CreativeContractPutBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new creativeContractService.CreativeContractValidationError(
      '作品の約束の形式が不正です。'
    );
  }
  const body = value as { revision?: unknown; items?: unknown; verificationMode?: unknown; confirmConflictFingerprint?: unknown };
  if (typeof body.revision !== 'number' || !Number.isFinite(body.revision)) {
    throw new creativeContractService.CreativeContractValidationError('revision が必要です。');
  }
  if (!Array.isArray(body.items)) {
    throw new creativeContractService.CreativeContractValidationError('契約項目が必要です。');
  }
  return {
    revision: Math.floor(body.revision),
    items: body.items as CreativeContractItemInput[],
    ...(body.verificationMode === 'fast' || body.verificationMode === 'strict'
      ? { verificationMode: body.verificationMode }
      : {}),
    ...(typeof body.confirmConflictFingerprint === 'string'
      ? { confirmConflictFingerprint: body.confirmConflictFingerprint }
      : {}),
  };
}

function generateCanonId(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  const r = Math.random().toString(36).slice(2, 6);
  return `can-${y}${m}${d}-${h}${min}${s}-${r}`;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asOptionalString(value: unknown): string | undefined {
  const text = asString(value);
  return text || undefined;
}

function asOptionalScope(value: unknown): CanonScope | undefined {
  return value === 'world' ||
    value === 'character' ||
    value === 'relationship' ||
    value === 'history' ||
    value === 'plot' ||
    value === 'other'
    ? value
    : undefined;
}

function asOptionalEpistemicStatus(value: unknown): LatentCanonItem['epistemicStatus'] | undefined {
  return value === 'fact' ||
    value === 'claim' ||
    value === 'belief' ||
    value === 'rumor' ||
    value === 'unknown'
    ? value
    : undefined;
}

export default router;

/**
 * Read and project relay storage usage while the caller's write transaction is
 * holding the database lock. Attachment stages are deliberately included in
 * the same budgets as public records: they are temporary, but still occupy
 * the relay's bounded storage.
 */
export function currentStorageUsage(db) {
  const records = db.prepare(`
    SELECT
      record_count AS recordCount,
      attachment_count AS attachmentCount,
      encrypted_bytes AS encryptedBytes
    FROM record_storage_usage
    WHERE singleton=1
  `).get();
  const stages = db.prepare(`
    SELECT stage_count AS stageCount,encrypted_bytes AS encryptedBytes
    FROM attachment_stage_usage
    WHERE singleton=1
  `).get();
  return {
    recordCount: Number(records?.recordCount ?? 0) + Number(stages?.stageCount ?? 0),
    attachmentCount: Number(records?.attachmentCount ?? 0) + Number(stages?.stageCount ?? 0),
    encryptedBytes: Number(records?.encryptedBytes ?? 0) + Number(stages?.encryptedBytes ?? 0),
  };
}

export function projectedStorageUsage(usage, delta = {}) {
  return {
    recordCount: usage.recordCount + Number(delta.recordCount ?? 0),
    attachmentCount: usage.attachmentCount + Number(delta.attachmentCount ?? 0),
    encryptedBytes: usage.encryptedBytes + Number(delta.encryptedBytes ?? 0),
  };
}

/**
 * Return the first quota exceeded by a write that grows that budget. A write
 * which reduces an already-over-limit budget is intentionally allowed so an
 * operator can repair an over-budget vault.
 */
export function storageQuotaError(usage, projected, limits) {
  if (
    projected.recordCount > limits.maxRecords
    && projected.recordCount > usage.recordCount
  ) return 'record_count_limit';
  if (
    projected.attachmentCount > limits.maxAttachments
    && projected.attachmentCount > usage.attachmentCount
  ) return 'attachment_count_limit';
  if (
    projected.encryptedBytes > limits.maxEncryptedBytes
    && projected.encryptedBytes > usage.encryptedBytes
  ) return 'encrypted_record_bytes_limit';
  return null;
}

export function checkStorageQuota(db, limits, delta = {}) {
  const usage = currentStorageUsage(db);
  const projected = projectedStorageUsage(usage, delta);
  return { usage, projected, error: storageQuotaError(usage, projected, limits) };
}

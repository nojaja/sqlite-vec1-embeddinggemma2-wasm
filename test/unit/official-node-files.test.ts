import { mkdtempSync, rmSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeSqliteFiles } from "../../src/official/node-files";

test("official node files: owns lock, short reads, durable writes and reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "official-node-files-"));
  const files = new NodeSqliteFiles();
  const filename = join(root, "database.sqlite3");
  try {
    files.open(1, filename, { create: true, readonly: false, main: true, removeOnClose: false });
    expect(() => files.open(2, filename, { create: true, readonly: false, main: true, removeOnClose: false })).toThrow("E_DATABASE_LOCKED");
    files.write(1, new Uint8Array([1, 2, 3]), 0);
    files.sync(1);
    expect(readFileSync(filename)).toEqual(Buffer.from([1, 2, 3]));
    const bytes = new Uint8Array(5).fill(9);
    expect(files.read(1, bytes, 0)).toBe(3);
    expect(bytes).toEqual(new Uint8Array([1, 2, 3, 0, 0]));
    files.truncate(1, 2);
    expect(files.size(1)).toBe(2);
    files.close(1);
    files.open(3, filename, { create: false, readonly: true, main: true, removeOnClose: false });
    expect(files.size(3)).toBe(2);
    files.close(3);
  } finally { files.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("official node files: rejects symlink database and cleans temporary files", () => {
  const root = mkdtempSync(join(tmpdir(), "official-node-files-"));
  const files = new NodeSqliteFiles();
  try {
    const target = join(root, "target.sqlite3");
    files.open(1, target, { create: true, readonly: false, main: false, removeOnClose: false });
    files.close(1);
    if (process.platform !== "win32") {
      const link = join(root, "link.sqlite3"); symlinkSync(target, link);
      expect(() => files.open(2, link, { create: false, readonly: false, main: true, removeOnClose: false })).toThrow("E_STORAGE");
    }
    files.open(3, null, { create: true, readonly: false, main: false, removeOnClose: true });
    files.write(3, new Uint8Array([7]), 0);
    expect(files.size(3)).toBe(1);
    files.close(3);
    expect(() => files.size(3)).toThrow("E_STORAGE");
  } finally { files.dispose(); rmSync(root, { recursive: true, force: true }); }
});
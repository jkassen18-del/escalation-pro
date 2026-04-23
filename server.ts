import cookieParser from "cookie-parser";
import crypto from "crypto";
import express from "express";
import session from "express-session";
import fs from "fs";
import multer from "multer";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import * as XLSX from "xlsx";

type UserRole = "admin" | "user";
type WorkItemStatus = "Open" | "Pending" | "Closed" | "Cancelled" | "Archive";
type SqlDialect = "postgres" | "mysql" | "mssql" | "sqlite";

interface User {
  id: string;
  username: string;
  passwordHash: string;
  passwordSalt: string;
  password?: string;
  name: string;
  email: string;
  role: UserRole;
  enabled: boolean;
  accessKeys: string[];
  departmentIds: string[];
  lastLoginAt?: string;
}

interface Note {
  id: string;
  text: string;
  authorId: string;
  authorName: string;
  timestamp: string;
}

interface Attachment {
  id: string;
  filename: string;
  originalName: string;
  mimetype: string;
  size: number;
  uploadedBy: string;
  uploadedById: string;
  timestamp: string;
}

interface WorkItemEvent {
  id: string;
  timestamp: string;
  actorId: string;
  actorName: string;
  action: string;
  details: string;
}

interface WorkItem {
  id: string;
  title: string;
  description: string;
  departmentId: string;
  subCategory: string;
  customFields: Record<string, unknown>;
  status: WorkItemStatus;
  creatorId: string;
  assigneeId: string | null;
  createdAt: string;
  updatedAt: string;
  pendingReason?: string;
  qualityRating?: number;
  notes: Note[];
  attachments: Attachment[];
  history: WorkItemEvent[];
}

interface Department {
  id: string;
  name: string;
  subCategories: Array<{
    name: string;
    fields: Array<{
      name: string;
      type: string;
      required?: boolean;
      options?: string[];
    }>;
  }>;
  visibility: "all" | "department" | "restricted";
  autoAssign: "round-robin" | "least-busy" | null;
  accessTemplate: string[];
  lastAssignedUserId?: string | null;
}

interface AuditLogEntry {
  id: string;
  timestamp: string;
  actorId: string;
  actorName: string;
  entityType: "work-item" | "user" | "department" | "settings" | "auth";
  entityId: string;
  action: string;
  details: string;
  changes?: Record<string, unknown>;
}

interface DB {
  users: User[];
  workItems: WorkItem[];
  departments: Department[];
  settings: {
    globalSLA: number;
    dbProfiles: unknown[];
    appName?: string;
    nextWorkItemNumber?: number;
    dataBackend?: {
      mode: "excel" | "sql";
      initialized: boolean;
      excelPath?: string;
      sqlProfileId?: string;
    };
    smtp?: {
      enabled?: boolean;
      host?: string;
      port?: number;
      secure?: boolean;
      username?: string;
      password?: string;
      fromEmail?: string;
      fromName?: string;
    };
    teams?: {
      enabled?: boolean;
      webhookUrl?: string;
    };
    notifications?: {
      onCreate?: boolean;
      onAssign?: boolean;
      departmentEmails?: Record<string, string[]>;
      templates?: {
        create?: string;
        assign?: string;
      };
    };
    sqlIntegrations?: Array<{
      id: string;
      name: string;
      dialect: SqlDialect;
      enabled?: boolean;
      syncOnWrite?: boolean;
      connectionString?: string;
      host?: string;
      port?: number;
      database?: string;
      username?: string;
      password?: string;
      filePath?: string;
      defaultSchema?: string;
      tableMappings?: {
        workItems?: string;
        users?: string;
        departments?: string;
      };
    }>;
  };
  auditLog: AuditLogEntry[];
}

const DB_PATH = path.join(process.cwd(), "db.json");
const UPLOADS_DIR = path.join(process.cwd(), "uploads");
const EXPORT_DIR = path.join(process.cwd(), "exports");
const LIVE_WORKBOOK_PATH = path.join(EXPORT_DIR, "slayr-crm-data.xlsx");
const SESSION_SECRET = process.env.SESSION_SECRET ?? crypto.randomBytes(32).toString("hex");
const CRM_USE_SQL_BACKEND = (process.env.CRM_DB_MODE ?? "").toLowerCase() === "sql";
const CRM_SQL_STATE_TABLE = process.env.CRM_SQL_STATE_TABLE ?? "crm_state";
const CRM_SQL_SYNC_POLL_MS = Math.max(1000, Number(process.env.CRM_SQL_SYNC_POLL_MS ?? 3000));

const ALL_ACCESS_KEYS = [
  "View All Work Items",
  "Assign Work Items",
  "Close Or Update Work Items",
  "Manage Users",
  "Edit User Information",
  "Reset User Passwords",
  "Delete Users",
  "Import Users",
  "Manage Routing",
  "Manage Form Builder",
  "Set SLA",
  "Departmental Notifications",
  "View Reports",
  "View Archive",
  "Export Archive",
];

const ALLOWED_UPLOAD_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
if (!fs.existsSync(EXPORT_DIR)) {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
}

declare module "express-session" {
  interface SessionData {
    userId: string;
  }
}

type SqlStateQueryResult = {
  rows?: any[];
};

type SqlStateClient = {
  query: (sql: string, params?: any[]) => Promise<SqlStateQueryResult>;
  close: () => Promise<void>;
};

let cachedDb: DB | null = null;
let sqlStateClient: SqlStateClient | null = null;
let sqlPersistenceEnabled = false;
let lastSqlUpdatedAt: string | null = null;
let sqlSaveInFlight = false;
let sqlPollHandle: NodeJS.Timeout | null = null;

function cloneDB(db: DB): DB {
  return JSON.parse(JSON.stringify(db)) as DB;
}

function readDBFromFile(): DB {
  if (!fs.existsSync(DB_PATH)) {
    const emptyDb = createEmptyDB();
    fs.writeFileSync(DB_PATH, JSON.stringify(emptyDb, null, 2), "utf-8");
    return emptyDb;
  }

  const raw = JSON.parse(fs.readFileSync(DB_PATH, "utf-8")) as DB;
  const db: DB = {
    users: Array.isArray(raw.users) ? raw.users : [],
    workItems: Array.isArray(raw.workItems) ? raw.workItems : [],
    departments: Array.isArray(raw.departments) ? (raw.departments as Department[]) : [],
    settings: raw.settings ?? { globalSLA: 24, dbProfiles: [], appName: "GML CRM", nextWorkItemNumber: undefined },
    auditLog: Array.isArray((raw as DB).auditLog) ? (raw as DB).auditLog : [],
  };

  const changed = ensureDefaultData(db);
  if (changed) {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
  }
  return db;
}

function writeDBToFile(db: DB) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
}

function getSqlConnectionConfig() {
  if (process.env.CRM_SQL_CONNECTION_STRING) {
    return { connectionString: process.env.CRM_SQL_CONNECTION_STRING };
  }
  return {
    host: process.env.CRM_SQL_HOST ?? "localhost",
    port: Number(process.env.CRM_SQL_PORT ?? 5432),
    database: process.env.CRM_SQL_DATABASE ?? "crm",
    user: process.env.CRM_SQL_USER ?? "crm",
    password: process.env.CRM_SQL_PASSWORD ?? "crm",
  };
}

async function connectSqlStateClient() {
  if (sqlStateClient) return;

  const pg = await optionalImport("pg");
  const pool = new pg.Pool(getSqlConnectionConfig());

  await pool.query("SELECT 1");
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${CRM_SQL_STATE_TABLE} (id SMALLINT PRIMARY KEY, payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
  );

  sqlStateClient = {
    query: (sql: string, params?: any[]) => pool.query(sql, params),
    close: async () => {
      await pool.end();
    },
  };
  sqlPersistenceEnabled = true;
  console.log(`[sql-state] SQL backend enabled via table '${CRM_SQL_STATE_TABLE}'`);
}

async function loadDBFromSql(): Promise<DB | null> {
  if (!sqlStateClient) return null;
  const result = await sqlStateClient.query(
    `SELECT payload::text AS payload, updated_at::text AS updated_at FROM ${CRM_SQL_STATE_TABLE} WHERE id = 1`
  );
  const row = result.rows?.[0];
  if (!row?.payload) return null;

  const parsed = JSON.parse(String(row.payload)) as DB;
  ensureDefaultData(parsed);
  lastSqlUpdatedAt = row.updated_at ? String(row.updated_at) : null;
  return parsed;
}

async function persistDBToSql(db: DB) {
  if (!sqlStateClient || !sqlPersistenceEnabled || sqlSaveInFlight) return;
  sqlSaveInFlight = true;
  try {
    const payload = JSON.stringify(db);
    const result = await sqlStateClient.query(
      `INSERT INTO ${CRM_SQL_STATE_TABLE} (id, payload, updated_at)
       VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (id)
       DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
       RETURNING updated_at::text AS updated_at`,
      [payload]
    );
    const updatedAt = result.rows?.[0]?.updated_at;
    if (updatedAt) {
      lastSqlUpdatedAt = String(updatedAt);
    }
  } catch (err) {
    console.error("[sql-state] Failed to persist DB state", err);
  } finally {
    sqlSaveInFlight = false;
  }
}

async function refreshDBFromSqlIfChanged() {
  if (!sqlStateClient || !sqlPersistenceEnabled || sqlSaveInFlight) return;
  try {
    const result = await sqlStateClient.query(
      `SELECT payload::text AS payload, updated_at::text AS updated_at FROM ${CRM_SQL_STATE_TABLE} WHERE id = 1`
    );
    const row = result.rows?.[0];
    if (!row?.payload || !row?.updated_at) return;
    const rowUpdatedAt = String(row.updated_at);
    if (lastSqlUpdatedAt && new Date(rowUpdatedAt).getTime() <= new Date(lastSqlUpdatedAt).getTime()) {
      return;
    }

    const incoming = JSON.parse(String(row.payload)) as DB;
    ensureDefaultData(incoming);
    cachedDb = incoming;
    lastSqlUpdatedAt = rowUpdatedAt;

    writeDBToFile(incoming);
    syncExcelWorkbook(incoming);
  } catch (err) {
    console.error("[sql-state] Failed to refresh DB state", err);
  }
}

async function initializePersistence() {
  let bootDb = readDBFromFile();

  if (CRM_USE_SQL_BACKEND) {
    try {
      await connectSqlStateClient();
      const sqlDb = await loadDBFromSql();
      if (sqlDb) {
        bootDb = sqlDb;
      } else {
        await persistDBToSql(bootDb);
      }

      if (!sqlPollHandle) {
        sqlPollHandle = setInterval(() => {
          void refreshDBFromSqlIfChanged();
        }, CRM_SQL_SYNC_POLL_MS);
      }
    } catch (err) {
      sqlPersistenceEnabled = false;
      console.error("[sql-state] SQL mode requested but unavailable, using db.json fallback", err);
    }
  }

  cachedDb = cloneDB(bootDb);
  writeDB(bootDb);
}

function hashPassword(password: string, providedSalt?: string) {
  const salt = providedSalt ?? crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password: string, user: User): boolean {
  if (!user.passwordHash || !user.passwordSalt) return false;
  const candidateHash = crypto.scryptSync(password, user.passwordSalt, 64);
  const storedHash = Buffer.from(user.passwordHash, "hex");
  if (candidateHash.length !== storedHash.length) return false;
  return crypto.timingSafeEqual(candidateHash, storedHash);
}

function sanitizeUser(user: User) {
  const { passwordHash, passwordSalt, password: _password, ...safeUser } = user;
  return safeUser;
}

function addAuditLog(
  db: DB,
  actor: Pick<User, "id" | "name">,
  entry: Omit<AuditLogEntry, "id" | "timestamp" | "actorId" | "actorName">
) {
  db.auditLog.unshift({
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    actorId: actor.id,
    actorName: actor.name,
    ...entry,
  });
}

function appendWorkItemEvent(
  item: WorkItem,
  actor: Pick<User, "id" | "name">,
  action: string,
  details: string
) {
  item.history.unshift({
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    actorId: actor.id,
    actorName: actor.name,
    action,
    details,
  });
}

function calcHoursOpen(createdAt: string, updatedAt: string) {
  const started = new Date(createdAt).getTime();
  const ended = new Date(updatedAt).getTime();
  return Number(((ended - started) / (1000 * 60 * 60)).toFixed(2));
}

function syncExcelWorkbook(db: DB) {
  const wb = XLSX.utils.book_new();

  const usersRows = db.users.map((u) => ({
    id: u.id,
    username: u.username,
    name: u.name,
    email: u.email,
    role: u.role,
    enabled: u.enabled,
    departments: u.departmentIds.join(" | "),
    accessKeys: u.accessKeys.join(" | "),
    lastLoginAt: u.lastLoginAt ?? "",
  }));

  const departmentsRows = db.departments.map((d) => ({
    id: d.id,
    name: d.name,
    visibility: d.visibility,
    autoAssign: d.autoAssign ?? "manual",
    accessTemplate: d.accessTemplate.join(" | "),
    subCategoryCount: d.subCategories.length,
  }));

  const workItemRows = db.workItems.map((item) => {
    const creator = db.users.find((u) => u.id === item.creatorId)?.name ?? item.creatorId;
    const assignee = db.users.find((u) => u.id === item.assigneeId)?.name ?? "Unassigned";
    const department = db.departments.find((d) => d.id === item.departmentId)?.name ?? item.departmentId;
    return {
      id: item.id,
      title: item.title,
      description: item.description,
      status: item.status,
      creator,
      assignee,
      createdDepartment: department,
      subCategory: item.subCategory,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      hoursOpen: calcHoursOpen(item.createdAt, item.updatedAt),
      pendingReason: item.pendingReason ?? "",
      qualityRating: item.qualityRating ?? "",
      customFields: JSON.stringify(item.customFields),
      notesCount: item.notes.length,
      attachmentsCount: item.attachments.length,
      latestEvent: item.history[0]?.action ?? "Created",
    };
  });

  const monthlyBuckets = new Map<string, typeof workItemRows>();
  for (const row of workItemRows) {
    const created = new Date(String(row.createdAt));
    const key = Number.isNaN(created.getTime())
      ? "Unknown-Month"
      : `${created.getUTCFullYear()}-${String(created.getUTCMonth() + 1).padStart(2, "0")}`;
    const existing = monthlyBuckets.get(key) ?? [];
    existing.push(row);
    monthlyBuckets.set(key, existing);
  }

  const historyRows = db.workItems.flatMap((item) =>
    item.history.map((event) => ({
      workItemId: item.id,
      timestamp: event.timestamp,
      actorId: event.actorId,
      actorName: event.actorName,
      action: event.action,
      details: event.details,
    }))
  );

  const auditRows = db.auditLog.map((a) => ({
    id: a.id,
    timestamp: a.timestamp,
    actorId: a.actorId,
    actorName: a.actorName,
    entityType: a.entityType,
    entityId: a.entityId,
    action: a.action,
    details: a.details,
    changes: a.changes ? JSON.stringify(a.changes) : "",
  }));

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(usersRows), "Users");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(departmentsRows), "Departments");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(workItemRows), "WorkItems_All");
  for (const [monthKey, rows] of [...monthlyBuckets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), `Esc_${monthKey}`.slice(0, 31));
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(historyRows), "WorkItemHistory");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(auditRows), "AuditLog");

  XLSX.writeFile(wb, LIVE_WORKBOOK_PATH);
}

function ensureDefaultData(db: DB) {
  let changed = false;
  if (!db.settings) {
    db.settings = { globalSLA: 24, dbProfiles: [], appName: "GML CRM", nextWorkItemNumber: undefined };
    changed = true;
  }
  if (!db.settings.appName) {
    db.settings.appName = "GML CRM";
    changed = true;
  }
  if (typeof db.settings.nextWorkItemNumber !== "number" || Number.isNaN(db.settings.nextWorkItemNumber)) {
    let seed = Math.floor(Math.random() * 90000) + 10000;
    const existingIds = new Set(db.workItems.map((w) => w.id));
    while (existingIds.has(`WI-${seed}`)) {
      seed += 1;
    }
    db.settings.nextWorkItemNumber = seed;
    changed = true;
  }

  if (!db.settings.dataBackend) {
    db.settings.dataBackend = {
      mode: "excel",
      initialized: db.users.length > 0,
      excelPath: LIVE_WORKBOOK_PATH,
    };
    changed = true;
  }

  if (!db.settings.smtp) {
    db.settings.smtp = {
      enabled: false,
      host: "",
      port: 587,
      secure: false,
      username: "",
      password: "",
      fromEmail: "",
      fromName: "GML CRM",
    };
    changed = true;
  }

  if (!db.settings.teams) {
    db.settings.teams = { enabled: false, webhookUrl: "" };
    changed = true;
  }

  if (!db.settings.notifications) {
    db.settings.notifications = {
      onCreate: true,
      onAssign: true,
      departmentEmails: {},
      templates: {
        create: "Work item {{id}} was created for {{department}} by {{creator}}.",
        assign: "Work item {{id}} was assigned to {{assignee}}.",
      },
    };
    changed = true;
  }

  if (!Array.isArray(db.settings.sqlIntegrations)) {
    db.settings.sqlIntegrations = [];
    changed = true;
  }

  for (const user of db.users) {
    user.accessKeys = Array.isArray(user.accessKeys) ? user.accessKeys : [];
    user.departmentIds = Array.isArray(user.departmentIds) ? user.departmentIds : [];

    if ((!user.passwordHash || !user.passwordSalt) && user.password) {
      const hashed = hashPassword(user.password);
      user.passwordHash = hashed.hash;
      user.passwordSalt = hashed.salt;
      delete user.password;
      changed = true;
    }
  }

  for (const dept of db.departments) {
    if (!dept.accessTemplate) {
      dept.accessTemplate = [];
      changed = true;
    }
    if (typeof dept.lastAssignedUserId === "undefined") {
      dept.lastAssignedUserId = null;
      changed = true;
    }
  }

  for (const item of db.workItems) {
    item.notes = Array.isArray(item.notes) ? item.notes : [];
    item.attachments = Array.isArray(item.attachments) ? item.attachments : [];
    item.history = Array.isArray(item.history) ? item.history : [];
    item.customFields = item.customFields ?? {};

    if (item.history.length === 0) {
      item.history.push({
        id: uuidv4(),
        timestamp: item.createdAt,
        actorId: item.creatorId,
        actorName: db.users.find((u) => u.id === item.creatorId)?.name ?? "System",
        action: "Created",
        details: "Work item created",
      });
      changed = true;
    }
  }

  if (!Array.isArray(db.auditLog)) {
    db.auditLog = [];
    changed = true;
  }

  if (db.users.length === 0) {
    db.settings.dataBackend.initialized = false;
    changed = true;
  }

  return changed;
}

function isSetupRequired(db: DB): boolean {
  const hasAdmin = db.users.some((u) => u.role === "admin" && u.enabled);
  const initialized = db.settings.dataBackend?.initialized === true;
  return !initialized || db.users.length === 0 || !hasAdmin;
}

function createEmptyDB(): DB {
  return {
    users: [],
    workItems: [],
    departments: [],
    settings: {
      globalSLA: 24,
      dbProfiles: [],
      appName: "GML CRM",
      nextWorkItemNumber: undefined,
      dataBackend: {
        mode: "excel",
        initialized: false,
        excelPath: LIVE_WORKBOOK_PATH,
      },
      sqlIntegrations: [],
    },
    auditLog: [],
  };
}

function readDB(): DB {
  if (!cachedDb) {
    cachedDb = readDBFromFile();
  }
  return cloneDB(cachedDb);
}

function writeDB(db: DB) {
  const next = cloneDB(db);
  ensureDefaultData(next);
  cachedDb = next;
  writeDBToFile(next);
  syncExcelWorkbook(next);
  if (sqlPersistenceEnabled) {
    void persistDBToSql(next);
  }
}

function getUserFromSession(req: express.Request, db: DB): User | undefined {
  if (!req.session.userId) return undefined;
  return db.users.find((u) => u.id === req.session.userId);
}

function hasAccess(user: User, department: Department | undefined, requiredKey?: string) {
  if (user.role === "admin") return true;
  if (!requiredKey) return true;
  const fromDepartment = department?.accessTemplate ?? [];
  return user.accessKeys.includes(requiredKey) || fromDepartment.includes(requiredKey);
}

function canViewItem(user: User, item: WorkItem) {
  if (user.role === "admin") return true;
  if (user.id === item.creatorId || user.id === item.assigneeId) return true;
  return user.departmentIds.includes(item.departmentId);
}

function canEditItem(user: User, item: WorkItem) {
  if (user.role === "admin") return true;
  if (user.id === item.creatorId || user.id === item.assigneeId) return true;
  if (user.departmentIds.includes(item.departmentId)) {
    return user.accessKeys.includes("Close Or Update Work Items") || user.accessKeys.includes("Assign Work Items");
  }
  return false;
}

function pickAutoAssignee(db: DB, department: Department): string | null {
  const candidates = db.users.filter(
    (u) => u.enabled && u.role !== "admin" && u.departmentIds.includes(department.id)
  );
  if (candidates.length === 0 || !department.autoAssign) return null;

  if (department.autoAssign === "round-robin") {
    if (!department.lastAssignedUserId) {
      department.lastAssignedUserId = candidates[0].id;
      return candidates[0].id;
    }
    const currentIndex = candidates.findIndex((u) => u.id === department.lastAssignedUserId);
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % candidates.length : 0;
    department.lastAssignedUserId = candidates[nextIndex].id;
    return candidates[nextIndex].id;
  }

  if (department.autoAssign === "least-busy") {
    const activeStatuses: WorkItemStatus[] = ["Open", "Pending"];
    const sortedByLoad = [...candidates].sort((a, b) => {
      const aLoad = db.workItems.filter(
        (item) => item.assigneeId === a.id && activeStatuses.includes(item.status)
      ).length;
      const bLoad = db.workItems.filter(
        (item) => item.assigneeId === b.id && activeStatuses.includes(item.status)
      ).length;
      return aLoad - bLoad;
    });
    return sortedByLoad[0]?.id ?? null;
  }

  return null;
}

function buildFilteredWorkItems(db: DB, query: Record<string, unknown>) {
  let items = [...db.workItems];
  const status = String(query.status ?? "").trim();
  const creatorId = String(query.creatorId ?? "").trim();
  const assigneeId = String(query.assigneeId ?? "").trim();
  const search = String(query.search ?? "").trim().toLowerCase();
  const from = String(query.from ?? "").trim();
  const to = String(query.to ?? "").trim();
  const mode = String(query.mode ?? "all").trim();
  const actorId = String(query.actorId ?? "").trim();
  const departmentIdsRaw = String(query.departmentIds ?? "").trim();
  const departmentIds = departmentIdsRaw ? departmentIdsRaw.split(",").map((s) => s.trim()) : [];

  if (status) items = items.filter((i) => i.status === status);
  if (creatorId) items = items.filter((i) => i.creatorId === creatorId);
  if (assigneeId) items = items.filter((i) => i.assigneeId === assigneeId);
  if (departmentIds.length > 0) items = items.filter((i) => departmentIds.includes(i.departmentId));

  if (mode === "created") {
    items = items.filter((i) => departmentIds.length === 0 || departmentIds.includes(i.departmentId));
  }
  if (mode === "worked") {
    items = items.filter((i) => {
      const touchedByAssignee = i.assigneeId ? i.assigneeId === actorId : false;
      const touchedByHistory = actorId ? i.history.some((h) => h.actorId === actorId) : true;
      return touchedByAssignee || touchedByHistory;
    });
  }

  if (actorId && mode !== "worked") {
    items = items.filter((i) => i.creatorId === actorId || i.assigneeId === actorId || i.history.some((h) => h.actorId === actorId));
  }

  if (from) {
    const fromDate = new Date(from);
    if (!Number.isNaN(fromDate.getTime())) {
      items = items.filter((i) => new Date(i.createdAt) >= fromDate);
    }
  }
  if (to) {
    const toDate = new Date(to);
    if (!Number.isNaN(toDate.getTime())) {
      items = items.filter((i) => new Date(i.createdAt) <= toDate);
    }
  }

  if (search) {
    items = items.filter(
      (i) =>
        i.title.toLowerCase().includes(search) ||
        i.description.toLowerCase().includes(search) ||
        i.id.toLowerCase().includes(search)
    );
  }

  return items;
}

function getNextWorkItemId(db: DB) {
  if (typeof db.settings.nextWorkItemNumber !== "number" || Number.isNaN(db.settings.nextWorkItemNumber)) {
    db.settings.nextWorkItemNumber = Math.floor(Math.random() * 90000) + 10000;
  }

  let next = Math.max(10000, Math.floor(db.settings.nextWorkItemNumber));
  const existing = new Set(db.workItems.map((w) => w.id));
  while (existing.has(`WI-${next}`)) {
    next += 1;
  }
  db.settings.nextWorkItemNumber = next + 1;
  return `WI-${next}`;
}

const optionalImport = new Function("name", "return import(name)") as (name: string) => Promise<any>;

function buildMessage(template: string, params: Record<string, string>) {
  let msg = template;
  for (const [key, value] of Object.entries(params)) {
    msg = msg.replaceAll(`{{${key}}}`, value);
  }
  return msg;
}

async function sendEmailNotification(db: DB, to: string[], subject: string, text: string) {
  const smtp = db.settings.smtp;
  if (!smtp?.enabled || !smtp.host || !smtp.username || !smtp.password) return;
  if (to.length === 0) return;

  try {
    const nodemailer = await optionalImport("nodemailer");
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: Number(smtp.port || 587),
      secure: Boolean(smtp.secure),
      auth: {
        user: smtp.username,
        pass: smtp.password,
      },
    });
    await transporter.sendMail({
      from: smtp.fromName ? `${smtp.fromName} <${smtp.fromEmail || smtp.username}>` : smtp.fromEmail || smtp.username,
      to: [...new Set(to)].join(","),
      subject,
      text,
    });
  } catch (err) {
    console.error("[smtp] Notification failed", err);
  }
}

async function sendTeamsNotification(db: DB, title: string, text: string) {
  const teams = db.settings.teams;
  if (!teams?.enabled || !teams.webhookUrl) return;
  try {
    await fetch(teams.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        text,
      }),
    });
  } catch (err) {
    console.error("[teams] Notification failed", err);
  }
}

function getNotificationRecipients(db: DB, item: WorkItem) {
  const departmentEmails = db.settings.notifications?.departmentEmails ?? {};
  const deptRecipients = departmentEmails[item.departmentId] ?? [];
  const assigneeEmail = db.users.find((u) => u.id === item.assigneeId)?.email;
  return [...new Set([...deptRecipients, ...(assigneeEmail ? [assigneeEmail] : [])])];
}

async function notifyWorkItemEvent(db: DB, item: WorkItem, event: "create" | "assign", actorName: string) {
  const notifications = db.settings.notifications;
  if (!notifications) return;

  const departmentName = db.departments.find((d) => d.id === item.departmentId)?.name ?? item.departmentId;
  const assigneeName = db.users.find((u) => u.id === item.assigneeId)?.name ?? "Unassigned";
  const creatorName = db.users.find((u) => u.id === item.creatorId)?.name ?? actorName;
  const subject = event === "create" ? `New escalation ${item.id}` : `Escalation reassigned ${item.id}`;
  const template =
    event === "create"
      ? notifications.templates?.create ?? "Work item {{id}} was created for {{department}} by {{creator}}."
      : notifications.templates?.assign ?? "Work item {{id}} was assigned to {{assignee}}.";
  const text = buildMessage(template, {
    id: item.id,
    department: departmentName,
    creator: creatorName,
    assignee: assigneeName,
    status: item.status,
  });

  const allow = event === "create" ? notifications.onCreate !== false : notifications.onAssign !== false;
  if (!allow) return;

  const recipients = getNotificationRecipients(db, item);
  await sendEmailNotification(db, recipients, subject, text);
  await sendTeamsNotification(db, subject, text);
}

async function getSqlClient(profile: NonNullable<DB["settings"]["sqlIntegrations"]>[number]) {
  const dialect = profile.dialect;
  if (dialect === "postgres") {
    const pg = await optionalImport("pg");
    const client = new pg.Client(
      profile.connectionString
        ? { connectionString: profile.connectionString }
        : {
            host: profile.host,
            port: profile.port || 5432,
            database: profile.database,
            user: profile.username,
            password: profile.password,
          }
    );
    await client.connect();
    return {
      query: (sql: string, params?: any[]) => client.query(sql, params),
      close: () => client.end(),
    };
  }

  if (dialect === "mysql") {
    const mysql = await optionalImport("mysql2/promise");
    const conn = await mysql.createConnection(
      profile.connectionString
        ? profile.connectionString
        : {
            host: profile.host,
            port: profile.port || 3306,
            database: profile.database,
            user: profile.username,
            password: profile.password,
          }
    );
    return {
      query: (sql: string, params?: any[]) => conn.query(sql, params),
      close: () => conn.end(),
    };
  }

  if (dialect === "mssql") {
    const mssql = await optionalImport("mssql");
    const pool = await mssql.connect(
      profile.connectionString
        ? profile.connectionString
        : {
            server: profile.host,
            port: profile.port || 1433,
            database: profile.database,
            user: profile.username,
            password: profile.password,
            options: { trustServerCertificate: true },
          }
    );
    return {
      query: (sql: string) => pool.request().query(sql),
      close: () => pool.close(),
    };
  }

  const sqlite = await optionalImport("sqlite3");
  const filePath = profile.filePath || path.join(process.cwd(), "external.sqlite");
  const dbHandle = new sqlite.Database(filePath);
  return {
    query: (sql: string, params?: any[]) =>
      new Promise<any>((resolve, reject) => {
        const trimmed = sql.trim().toLowerCase();
        if (trimmed.startsWith("select")) {
          dbHandle.all(sql, params ?? [], (err: Error | null, rows: any[]) => {
            if (err) reject(err);
            else resolve({ rows });
          });
        } else {
          dbHandle.run(sql, params ?? [], function (this: any, err: Error | null) {
            if (err) reject(err);
            else resolve({ changes: this.changes });
          });
        }
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        dbHandle.close((err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

async function syncWorkItemToSqlProfiles(db: DB, item: WorkItem) {
  const profiles = (db.settings.sqlIntegrations || []).filter((p) => p.enabled && p.syncOnWrite);
  for (const profile of profiles) {
    const tableName = profile.tableMappings?.workItems || "work_items";
    try {
      const client = await getSqlClient(profile);
      if (profile.dialect === "postgres") {
        await client.query(`CREATE TABLE IF NOT EXISTS ${tableName} (id TEXT PRIMARY KEY, title TEXT, description TEXT, status TEXT, department_id TEXT, assignee_id TEXT, creator_id TEXT, created_at TEXT, updated_at TEXT)`);
        await client.query(
          `INSERT INTO ${tableName} (id,title,description,status,department_id,assignee_id,creator_id,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description, status=EXCLUDED.status, department_id=EXCLUDED.department_id, assignee_id=EXCLUDED.assignee_id, creator_id=EXCLUDED.creator_id, created_at=EXCLUDED.created_at, updated_at=EXCLUDED.updated_at`,
          [item.id, item.title, item.description, item.status, item.departmentId, item.assigneeId, item.creatorId, item.createdAt, item.updatedAt]
        );
      } else if (profile.dialect === "mysql") {
        await client.query(`CREATE TABLE IF NOT EXISTS ${tableName} (id VARCHAR(64) PRIMARY KEY, title TEXT, description TEXT, status VARCHAR(32), department_id VARCHAR(64), assignee_id VARCHAR(64), creator_id VARCHAR(64), created_at TEXT, updated_at TEXT)`);
        await client.query(
          `INSERT INTO ${tableName} (id,title,description,status,department_id,assignee_id,creator_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE title=VALUES(title), description=VALUES(description), status=VALUES(status), department_id=VALUES(department_id), assignee_id=VALUES(assignee_id), creator_id=VALUES(creator_id), created_at=VALUES(created_at), updated_at=VALUES(updated_at)`,
          [item.id, item.title, item.description, item.status, item.departmentId, item.assigneeId, item.creatorId, item.createdAt, item.updatedAt]
        );
      } else if (profile.dialect === "mssql") {
        await client.query(`IF OBJECT_ID('${tableName}', 'U') IS NULL CREATE TABLE ${tableName} (id NVARCHAR(64) PRIMARY KEY, title NVARCHAR(MAX), description NVARCHAR(MAX), status NVARCHAR(32), department_id NVARCHAR(64), assignee_id NVARCHAR(64), creator_id NVARCHAR(64), created_at NVARCHAR(64), updated_at NVARCHAR(64));`);
        await client.query(
          `MERGE ${tableName} AS target USING (SELECT '${item.id}' AS id) AS src ON target.id=src.id WHEN MATCHED THEN UPDATE SET title='${item.title.replaceAll("'", "''")}', description='${item.description.replaceAll("'", "''")}', status='${item.status}', department_id='${item.departmentId}', assignee_id='${item.assigneeId ?? ""}', creator_id='${item.creatorId}', created_at='${item.createdAt}', updated_at='${item.updatedAt}' WHEN NOT MATCHED THEN INSERT (id,title,description,status,department_id,assignee_id,creator_id,created_at,updated_at) VALUES ('${item.id}','${item.title.replaceAll("'", "''")}','${item.description.replaceAll("'", "''")}','${item.status}','${item.departmentId}','${item.assigneeId ?? ""}','${item.creatorId}','${item.createdAt}','${item.updatedAt}');`
        );
      } else {
        await client.query(`CREATE TABLE IF NOT EXISTS ${tableName} (id TEXT PRIMARY KEY, title TEXT, description TEXT, status TEXT, department_id TEXT, assignee_id TEXT, creator_id TEXT, created_at TEXT, updated_at TEXT)`);
        await client.query(
          `INSERT INTO ${tableName} (id,title,description,status,department_id,assignee_id,creator_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description, status=excluded.status, department_id=excluded.department_id, assignee_id=excluded.assignee_id, creator_id=excluded.creator_id, created_at=excluded.created_at, updated_at=excluded.updated_at`,
          [item.id, item.title, item.description, item.status, item.departmentId, item.assigneeId, item.creatorId, item.createdAt, item.updatedAt]
        );
      }
      await client.close();
    } catch (err) {
      console.error(`[sql-sync] Failed for profile ${profile.name}`, err);
    }
  }
}

async function startServer() {
  await initializePersistence();

  const app = express();
  const PORT = Number(process.env.PORT ?? 3000);
  const COOKIE_SECURE = (process.env.SESSION_COOKIE_SECURE ?? "auto").toLowerCase();

  // Required for secure cookies when running behind managed proxies/load balancers.
  app.set("trust proxy", 1);

  app.use(express.json({ limit: "2mb" }));
  app.use(cookieParser());
  app.use(
    session({
      secret: SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure:
          COOKIE_SECURE === "true"
            ? true
            : COOKIE_SECURE === "false"
              ? false
              : process.env.NODE_ENV === "production",
        httpOnly: true,
        sameSite: "lax",
        maxAge: 24 * 60 * 60 * 1000,
      },
    })
  );

  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const safeOriginal = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `${uuidv4()}-${safeOriginal}`);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (!ALLOWED_UPLOAD_TYPES.has(file.mimetype)) {
        cb(new Error("Unsupported file type"));
        return;
      }
      cb(null, true);
    },
  });

  const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const db = readDB();
    if (isSetupRequired(db)) {
      return res.status(503).json({ error: "System setup required", setupRequired: true });
    }
    const user = getUserFromSession(req, db);
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!user.enabled) {
      return res.status(403).json({ error: "Account disabled" });
    }
    next();
  };

  const requirePermission = (permissionKey: string) => {
    return (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const db = readDB();
      if (isSetupRequired(db)) {
        return res.status(503).json({ error: "System setup required", setupRequired: true });
      }
      const user = getUserFromSession(req, db);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (user.role === "admin" || user.accessKeys.includes(permissionKey)) return next();
      return res.status(403).json({ error: "Forbidden" });
    };
  };

  app.get("/api/setup/status", (_req, res) => {
    const db = readDB();
    const backend = db.settings.dataBackend;
    const mode = backend?.mode ?? "excel";
    const workbookPath = backend?.excelPath || LIVE_WORKBOOK_PATH;
    const sqlProfiles = (db.settings.sqlIntegrations ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      dialect: p.dialect,
      enabled: p.enabled !== false,
    }));

    res.json({
      setupRequired: isSetupRequired(db),
      initialized: backend?.initialized === true,
      mode,
      appName: db.settings.appName || "GML CRM",
      hasWorkbook: fs.existsSync(workbookPath),
      sqlProfiles,
    });
  });

  app.post("/api/setup/initialize", (req, res) => {
    const db = readDB();
    if (!isSetupRequired(db)) {
      return res.status(409).json({ error: "System is already initialized" });
    }

    const mode = req.body?.mode === "sql" ? "sql" : "excel";
    const appName = String(req.body?.appName || "GML CRM").trim() || "GML CRM";
    const sqlProfileId = req.body?.sqlProfileId ? String(req.body.sqlProfileId) : undefined;

    const adminName = String(req.body?.admin?.name || "").trim();
    const adminEmail = String(req.body?.admin?.email || "").trim();
    const adminUsername = String(req.body?.admin?.username || "").trim();
    const adminPassword = String(req.body?.admin?.password || "");

    if (!adminName || !adminEmail || !adminUsername || !adminPassword) {
      return res.status(400).json({ error: "Admin name, email, username, and password are required" });
    }
    if (adminPassword.length < 8) {
      return res.status(400).json({ error: "Admin password must be at least 8 characters" });
    }

    if (mode === "sql") {
      if (!sqlProfileId) {
        return res.status(400).json({ error: "A SQL profile is required when SQL mode is selected" });
      }
      const sqlProfile = (db.settings.sqlIntegrations ?? []).find((p) => p.id === sqlProfileId);
      if (!sqlProfile) {
        return res.status(400).json({ error: "Selected SQL profile was not found" });
      }
    }

    if (db.users.some((u) => u.username.toLowerCase() === adminUsername.toLowerCase())) {
      return res.status(409).json({ error: "Username is already in use" });
    }

    const hashed = hashPassword(adminPassword);
    const adminUser: User = {
      id: uuidv4(),
      username: adminUsername,
      passwordHash: hashed.hash,
      passwordSalt: hashed.salt,
      name: adminName,
      email: adminEmail,
      role: "admin",
      enabled: true,
      accessKeys: [...ALL_ACCESS_KEYS],
      departmentIds: db.departments.map((d) => d.id),
      lastLoginAt: new Date().toISOString(),
    };

    db.settings.appName = appName;
    db.settings.dataBackend = {
      mode,
      initialized: true,
      excelPath: LIVE_WORKBOOK_PATH,
      sqlProfileId: mode === "sql" ? sqlProfileId : undefined,
    };
    db.users.push(adminUser);
    addAuditLog(db, adminUser, {
      entityType: "settings",
      entityId: "setup",
      action: "INITIALIZE",
      details: `Initialized system with ${mode.toUpperCase()} backend`,
      changes: { mode, sqlProfileId: sqlProfileId ?? null },
    });

    req.session.userId = adminUser.id;
    writeDB(db);
    res.json({ success: true, user: sanitizeUser(adminUser), setupRequired: false });
  });

  app.post("/api/auth/login", (req, res) => {
    const { username, password } = req.body ?? {};
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required" });
    }

    const db = readDB();
    if (isSetupRequired(db)) {
      return res.status(503).json({ error: "System setup required", setupRequired: true });
    }
    const user = db.users.find((u) => u.username.toLowerCase() === String(username).toLowerCase());

    if (!user || !verifyPassword(String(password), user)) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    if (!user.enabled) {
      return res.status(403).json({ error: "Account disabled" });
    }

    user.lastLoginAt = new Date().toISOString();
    req.session.userId = user.id;
    addAuditLog(db, user, {
      entityType: "auth",
      entityId: user.id,
      action: "LOGIN",
      details: `${user.username} logged in`,
    });
    writeDB(db);
    res.json(sanitizeUser(user));
  });

  app.post("/api/auth/logout", requireAuth, (req, res) => {
    const db = readDB();
    const user = getUserFromSession(req, db)!;
    addAuditLog(db, user, {
      entityType: "auth",
      entityId: user.id,
      action: "LOGOUT",
      details: `${user.username} logged out`,
    });
    writeDB(db);

    req.session.destroy((err) => {
      if (err) return res.status(500).json({ error: "Logout failed" });
      return res.json({ success: true });
    });
  });

  app.get("/api/auth/me", (req, res) => {
    const db = readDB();
    if (isSetupRequired(db)) {
      return res.status(503).json({ error: "System setup required", setupRequired: true });
    }
    const user = getUserFromSession(req, db);
    if (!user) {
      return res.status(401).json({ error: "Not logged in" });
    }
    return res.json(sanitizeUser(user));
  });

  app.get("/api/work-items", requireAuth, (req, res) => {
    const db = readDB();
    const user = getUserFromSession(req, db)!;
    let items = buildFilteredWorkItems(db, req.query as Record<string, unknown>);

    items = items.filter((item) => canViewItem(user, item));
    items.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    const enriched = items.map((item) => ({
      ...item,
      creatorName: db.users.find((u) => u.id === item.creatorId)?.name ?? "Unknown",
      assigneeName: db.users.find((u) => u.id === item.assigneeId)?.name ?? "Unassigned",
      departmentName: db.departments.find((d) => d.id === item.departmentId)?.name ?? item.departmentId,
    }));
    res.json(enriched);
  });

  app.post("/api/work-items", requireAuth, (req, res) => {
    const db = readDB();
    const user = getUserFromSession(req, db)!;

    const { title, description, departmentId, subCategory, customFields } = req.body ?? {};
    if (!title || !description || !departmentId || !subCategory) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const department = db.departments.find((d) => d.id === departmentId);
    if (!department) {
      return res.status(400).json({ error: "Invalid department" });
    }

    const assigneeId = pickAutoAssignee(db, department);
    const now = new Date().toISOString();
    const newItem: WorkItem = {
      id: getNextWorkItemId(db),
      title: String(title),
      description: String(description),
      departmentId: String(departmentId),
      subCategory: String(subCategory),
      customFields: customFields ?? {},
      status: "Open",
      creatorId: user.id,
      assigneeId,
      createdAt: now,
      updatedAt: now,
      notes: [],
      attachments: [],
      history: [],
    };

    appendWorkItemEvent(newItem, user, "Created", "Work item created");
    if (assigneeId) {
      const assignedTo = db.users.find((u) => u.id === assigneeId)?.name ?? assigneeId;
      appendWorkItemEvent(newItem, user, "Auto Assigned", `Assigned to ${assignedTo}`);
    }

    db.workItems.push(newItem);
    addAuditLog(db, user, {
      entityType: "work-item",
      entityId: newItem.id,
      action: "CREATE",
      details: `Created work item ${newItem.id}`,
      changes: {
        departmentId: newItem.departmentId,
        subCategory: newItem.subCategory,
        assigneeId: newItem.assigneeId,
      },
    });
    writeDB(db);
    void notifyWorkItemEvent(db, newItem, "create", user.name);
    void syncWorkItemToSqlProfiles(db, newItem);
    res.json(newItem);
  });

  app.patch("/api/work-items/:id", requireAuth, (req, res) => {
    const db = readDB();
    const user = getUserFromSession(req, db)!;
    const index = db.workItems.findIndex((i) => i.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: "Not found" });

    const item = db.workItems[index];
    if (!canEditItem(user, item)) {
      return res.status(403).json({ error: "You do not have permission to update this item" });
    }

    if (req.body?.status === "Cancelled" && item.creatorId !== user.id && user.role !== "admin") {
      return res.status(403).json({ error: "Only creator or admin can cancel" });
    }

    const before = {
      status: item.status,
      assigneeId: item.assigneeId,
      departmentId: item.departmentId,
      pendingReason: item.pendingReason,
      qualityRating: item.qualityRating,
    };

    const nextItem: WorkItem = {
      ...item,
      ...req.body,
      updatedAt: new Date().toISOString(),
    };

    if (req.body?.departmentId && req.body.departmentId !== item.departmentId) {
      const nextDept = db.departments.find((d) => d.id === req.body.departmentId);
      if (!nextDept) {
        return res.status(400).json({ error: "Invalid department" });
      }
      if (!req.body.assigneeId) {
        nextItem.assigneeId = pickAutoAssignee(db, nextDept);
      }
    }

    if (before.status !== nextItem.status) {
      appendWorkItemEvent(nextItem, user, "Status Changed", `${before.status} -> ${nextItem.status}`);
    }
    if (before.assigneeId !== nextItem.assigneeId) {
      const beforeName = db.users.find((u) => u.id === before.assigneeId)?.name ?? "Unassigned";
      const afterName = db.users.find((u) => u.id === nextItem.assigneeId)?.name ?? "Unassigned";
      appendWorkItemEvent(nextItem, user, "Assignment Changed", `${beforeName} -> ${afterName}`);
    }
    if (before.departmentId !== nextItem.departmentId) {
      const beforeDept = db.departments.find((d) => d.id === before.departmentId)?.name ?? before.departmentId;
      const afterDept = db.departments.find((d) => d.id === nextItem.departmentId)?.name ?? nextItem.departmentId;
      appendWorkItemEvent(nextItem, user, "Department Changed", `${beforeDept} -> ${afterDept}`);
    }

    db.workItems[index] = nextItem;
    addAuditLog(db, user, {
      entityType: "work-item",
      entityId: item.id,
      action: "UPDATE",
      details: `Updated work item ${item.id}`,
      changes: {
        before,
        after: {
          status: nextItem.status,
          assigneeId: nextItem.assigneeId,
          departmentId: nextItem.departmentId,
          pendingReason: nextItem.pendingReason,
          qualityRating: nextItem.qualityRating,
        },
      },
    });
    writeDB(db);
    if (before.assigneeId !== nextItem.assigneeId) {
      void notifyWorkItemEvent(db, nextItem, "assign", user.name);
    }
    void syncWorkItemToSqlProfiles(db, nextItem);
    res.json(nextItem);
  });

  app.post("/api/work-items/:id/notes", requireAuth, (req, res) => {
    const db = readDB();
    const user = getUserFromSession(req, db)!;
    const index = db.workItems.findIndex((i) => i.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: "Not found" });
    const item = db.workItems[index];
    if (!canViewItem(user, item)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (!req.body?.text || !String(req.body.text).trim()) {
      return res.status(400).json({ error: "Note text is required" });
    }

    const newNote: Note = {
      id: uuidv4(),
      text: String(req.body.text),
      authorId: user.id,
      authorName: user.name,
      timestamp: new Date().toISOString(),
    };

    item.notes.unshift(newNote);
    item.updatedAt = new Date().toISOString();
    appendWorkItemEvent(item, user, "Note Added", newNote.text);
    addAuditLog(db, user, {
      entityType: "work-item",
      entityId: item.id,
      action: "ADD_NOTE",
      details: `Added note to ${item.id}`,
    });

    writeDB(db);
    res.json(newNote);
  });

  app.post("/api/work-items/:id/attachments", requireAuth, upload.single("file"), (req, res) => {
    const db = readDB();
    const user = getUserFromSession(req, db)!;
    const index = db.workItems.findIndex((i) => i.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: "Not found" });
    const item = db.workItems[index];
    if (!canEditItem(user, item)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });

    const newAttachment: Attachment = {
      id: uuidv4(),
      filename: file.filename,
      originalName: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      uploadedBy: user.name,
      uploadedById: user.id,
      timestamp: new Date().toISOString(),
    };

    item.attachments.unshift(newAttachment);
    item.updatedAt = new Date().toISOString();
    appendWorkItemEvent(item, user, "Attachment Uploaded", newAttachment.originalName);
    addAuditLog(db, user, {
      entityType: "work-item",
      entityId: item.id,
      action: "UPLOAD_ATTACHMENT",
      details: `Uploaded ${newAttachment.originalName} to ${item.id}`,
    });
    writeDB(db);
    res.json(newAttachment);
  });

  app.get("/api/work-items/:id/attachments/:filename", requireAuth, (req, res) => {
    const db = readDB();
    const user = getUserFromSession(req, db)!;
    const item = db.workItems.find((i) => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: "Work item not found" });
    if (!canViewItem(user, item)) return res.status(403).json({ error: "Forbidden" });

    const attachment = item.attachments.find((a) => a.filename === req.params.filename);
    if (!attachment) return res.status(404).json({ error: "Attachment not found" });

    const filePath = path.join(UPLOADS_DIR, attachment.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });
    res.download(filePath, attachment.originalName);
  });

  app.get("/api/work-items/:id/attachments/:filename/preview", requireAuth, (req, res) => {
    const db = readDB();
    const user = getUserFromSession(req, db)!;
    const item = db.workItems.find((i) => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: "Work item not found" });
    if (!canViewItem(user, item)) return res.status(403).json({ error: "Forbidden" });

    const attachment = item.attachments.find((a) => a.filename === req.params.filename);
    if (!attachment) return res.status(404).json({ error: "Attachment not found" });

    const filePath = path.join(UPLOADS_DIR, attachment.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });

    res.setHeader("Content-Type", attachment.mimetype);
    res.setHeader("Content-Disposition", `inline; filename=\"${attachment.originalName}\"`);
    res.sendFile(filePath);
  });

  app.get("/api/users/directory", requireAuth, (req, res) => {
    const db = readDB();
    const directory = db.users
      .filter((u) => u.enabled)
      .map((u) => ({ id: u.id, name: u.name, role: u.role, departmentIds: u.departmentIds }));
    res.json(directory);
  });

  app.get("/api/users", requireAuth, requirePermission("Manage Users"), (req, res) => {
    const db = readDB();
    res.json(db.users.map(sanitizeUser));
  });

  app.post("/api/users", requireAuth, requirePermission("Manage Users"), (req, res) => {
    const db = readDB();
    const actor = getUserFromSession(req, db)!;

    const { username, password, name, email, role, accessKeys, departmentIds } = req.body ?? {};
    if (!username || !password || !name || !email) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }
    if (db.users.some((u) => u.username.toLowerCase() === String(username).toLowerCase())) {
      return res.status(409).json({ error: "Username already exists" });
    }

    const hashed = hashPassword(String(password));
    const newUser: User = {
      id: uuidv4(),
      username: String(username).trim(),
      passwordHash: hashed.hash,
      passwordSalt: hashed.salt,
      name: String(name).trim(),
      email: String(email).trim(),
      role: role === "admin" ? "admin" : "user",
      enabled: true,
      accessKeys: Array.isArray(accessKeys) ? accessKeys.filter((k) => ALL_ACCESS_KEYS.includes(k)) : [],
      departmentIds: Array.isArray(departmentIds) ? departmentIds : [],
    };

    db.users.push(newUser);
    addAuditLog(db, actor, {
      entityType: "user",
      entityId: newUser.id,
      action: "CREATE",
      details: `Created user ${newUser.username}`,
    });
    writeDB(db);
    res.json(sanitizeUser(newUser));
  });

  app.patch("/api/users/:id", requireAuth, requirePermission("Edit User Information"), (req, res) => {
    const db = readDB();
    const actor = getUserFromSession(req, db)!;
    const index = db.users.findIndex((u) => u.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: "Not found" });

    const existing = db.users[index];
    const payload = { ...req.body };
    if (payload.password) {
      if (String(payload.password).length < 8) {
        return res.status(400).json({ error: "Password must be at least 8 characters" });
      }
      const hashed = hashPassword(String(payload.password));
      existing.passwordHash = hashed.hash;
      existing.passwordSalt = hashed.salt;
      delete payload.password;
    }

    if (payload.accessKeys && Array.isArray(payload.accessKeys)) {
      payload.accessKeys = payload.accessKeys.filter((k: string) => ALL_ACCESS_KEYS.includes(k));
    }

    db.users[index] = { ...existing, ...payload };
    addAuditLog(db, actor, {
      entityType: "user",
      entityId: existing.id,
      action: "UPDATE",
      details: `Updated user ${existing.username}`,
      changes: payload,
    });
    writeDB(db);
    res.json(sanitizeUser(db.users[index]));
  });

  app.delete("/api/users/:id", requireAuth, requirePermission("Delete Users"), (req, res) => {
    const db = readDB();
    const actor = getUserFromSession(req, db)!;
    if (actor.id === req.params.id) {
      return res.status(400).json({ error: "You cannot delete your own account" });
    }
    const existing = db.users.find((u) => u.id === req.params.id);
    db.users = db.users.filter((u) => u.id !== req.params.id);
    addAuditLog(db, actor, {
      entityType: "user",
      entityId: req.params.id,
      action: "DELETE",
      details: `Deleted user ${existing?.username ?? req.params.id}`,
    });
    writeDB(db);
    res.json({ success: true });
  });

  app.get("/api/departments", requireAuth, (req, res) => {
    const db = readDB();
    res.json(db.departments);
  });

  app.post("/api/departments", requireAuth, requirePermission("Manage Routing"), (req, res) => {
    const db = readDB();
    const actor = getUserFromSession(req, db)!;
    const newDept: Department = {
      id: uuidv4(),
      name: String(req.body?.name ?? "New Department"),
      subCategories: Array.isArray(req.body?.subCategories) ? req.body.subCategories : [],
      visibility: req.body?.visibility ?? "all",
      autoAssign: req.body?.autoAssign ?? null,
      accessTemplate: Array.isArray(req.body?.accessTemplate)
        ? req.body.accessTemplate.filter((k: string) => ALL_ACCESS_KEYS.includes(k))
        : [],
      lastAssignedUserId: null,
    };
    db.departments.push(newDept);
    addAuditLog(db, actor, {
      entityType: "department",
      entityId: newDept.id,
      action: "CREATE",
      details: `Created department ${newDept.name}`,
    });
    writeDB(db);
    res.json(newDept);
  });

  app.patch("/api/departments/:id", requireAuth, requirePermission("Manage Routing"), (req, res) => {
    const db = readDB();
    const actor = getUserFromSession(req, db)!;
    const index = db.departments.findIndex((d) => d.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: "Not found" });

    const payload = { ...req.body };
    if (payload.accessTemplate && Array.isArray(payload.accessTemplate)) {
      payload.accessTemplate = payload.accessTemplate.filter((k: string) => ALL_ACCESS_KEYS.includes(k));
    }

    db.departments[index] = { ...db.departments[index], ...payload };
    addAuditLog(db, actor, {
      entityType: "department",
      entityId: req.params.id,
      action: "UPDATE",
      details: `Updated department ${db.departments[index].name}`,
      changes: payload,
    });
    writeDB(db);
    res.json(db.departments[index]);
  });

  app.delete("/api/departments/:id", requireAuth, requirePermission("Manage Routing"), (req, res) => {
    const db = readDB();
    const actor = getUserFromSession(req, db)!;
    const existing = db.departments.find((d) => d.id === req.params.id);
    db.departments = db.departments.filter((d) => d.id !== req.params.id);
    addAuditLog(db, actor, {
      entityType: "department",
      entityId: req.params.id,
      action: "DELETE",
      details: `Deleted department ${existing?.name ?? req.params.id}`,
    });
    writeDB(db);
    res.json({ success: true });
  });

  app.get("/api/settings", requireAuth, (req, res) => {
    const db = readDB();
    res.json(db.settings);
  });

  app.patch("/api/settings", requireAuth, requirePermission("Set SLA"), (req, res) => {
    const db = readDB();
    const actor = getUserFromSession(req, db)!;
    db.settings = {
      ...db.settings,
      ...req.body,
      appName: "GML CRM",
    };
    addAuditLog(db, actor, {
      entityType: "settings",
      entityId: "global",
      action: "UPDATE",
      details: "Updated system settings",
      changes: req.body,
    });
    writeDB(db);
    res.json(db.settings);
  });

  app.post("/api/settings/test-smtp", requireAuth, requirePermission("Set SLA"), async (req, res) => {
    const db = readDB();
    const actor = getUserFromSession(req, db)!;
    const targetEmail = String(req.body?.to || actor.email || "").trim();
    if (!targetEmail) {
      return res.status(400).json({ error: "Target email is required" });
    }

    await sendEmailNotification(
      db,
      [targetEmail],
      "GML CRM SMTP Test",
      "SMTP integration is active and able to send notifications."
    );
    res.json({ success: true });
  });

  app.post("/api/settings/test-teams", requireAuth, requirePermission("Set SLA"), async (_req, res) => {
    const db = readDB();
    await sendTeamsNotification(db, "GML CRM Teams Test", "Teams webhook integration is active.");
    res.json({ success: true });
  });

  app.get("/api/integrations/sql/required-columns/:entity", requireAuth, requirePermission("Set SLA"), (req, res) => {
    const entity = String(req.params.entity || "").toLowerCase();
    const requiredByEntity: Record<string, string[]> = {
      "work-items": ["id", "title", "description", "status", "department_id", "creator_id", "assignee_id", "created_at", "updated_at"],
      users: ["id", "username", "name", "email", "role", "enabled"],
      departments: ["id", "name", "visibility", "auto_assign"],
    };
    const recommended = requiredByEntity[entity];
    if (!recommended) {
      return res.status(400).json({ error: "Unsupported entity. Use work-items, users, or departments." });
    }
    res.json({ entity, requiredColumns: recommended });
  });

  app.post("/api/integrations/sql/test-connection", requireAuth, requirePermission("Set SLA"), async (req, res) => {
    const profile = req.body?.profile;
    if (!profile?.dialect) {
      return res.status(400).json({ error: "SQL profile with dialect is required" });
    }

    try {
      const client = await getSqlClient(profile);
      await client.query("SELECT 1");
      await client.close();
      return res.json({ success: true });
    } catch (err: any) {
      return res.status(400).json({ error: err?.message || "Connection failed" });
    }
  });

  app.post("/api/integrations/sql/import", requireAuth, requirePermission("Set SLA"), async (req, res) => {
    const db = readDB();
    const profileId = String(req.body?.profileId || "");
    const entity = String(req.body?.entity || "work-items");
    const tableName = String(req.body?.tableName || "").trim();
    const limit = Math.min(Number(req.body?.limit || 200), 2000);

    if (!profileId || !tableName) {
      return res.status(400).json({ error: "profileId and tableName are required" });
    }
    const profile = (db.settings.sqlIntegrations || []).find((p) => p.id === profileId && p.enabled);
    if (!profile) {
      return res.status(404).json({ error: "SQL integration profile not found or disabled" });
    }

    try {
      const client = await getSqlClient(profile);
      const selectSql = profile.dialect === "mssql"
        ? `SELECT TOP (${limit}) * FROM ${tableName}`
        : `SELECT * FROM ${tableName} LIMIT ${limit}`;
      const raw = await client.query(selectSql);
      const rows = Array.isArray(raw?.rows) ? raw.rows : Array.isArray(raw?.[0]) ? raw[0] : [];
      await client.close();

      let imported = 0;
      if (entity === "work-items") {
        for (const row of rows) {
          const id = String(row.id || getNextWorkItemId(db));
          const existingIndex = db.workItems.findIndex((w) => w.id === id);
          const candidate: WorkItem = {
            id,
            title: String(row.title || "Imported Work Item"),
            description: String(row.description || "Imported from SQL"),
            departmentId: String(row.department_id || row.departmentId || db.departments[0]?.id || ""),
            subCategory: String(row.sub_category || row.subCategory || "General"),
            customFields: {},
            status: (row.status as WorkItemStatus) || "Open",
            creatorId: String(row.creator_id || row.creatorId || db.users[0]?.id || ""),
            assigneeId: row.assignee_id || row.assigneeId || null,
            createdAt: String(row.created_at || row.createdAt || new Date().toISOString()),
            updatedAt: String(row.updated_at || row.updatedAt || new Date().toISOString()),
            notes: [],
            attachments: [],
            history: [],
          };
          if (existingIndex >= 0) {
            db.workItems[existingIndex] = { ...db.workItems[existingIndex], ...candidate };
          } else {
            db.workItems.push(candidate);
          }
          imported += 1;
        }
      } else if (entity === "users") {
        for (const row of rows) {
          const id = String(row.id || uuidv4());
          const existing = db.users.find((u) => u.id === id || u.username === String(row.username || ""));
          if (existing) {
            existing.name = String(row.name || existing.name);
            existing.email = String(row.email || existing.email);
            existing.enabled = String(row.enabled ?? "true") !== "false";
          } else {
            const hashed = hashPassword("ChangeMe!123");
            db.users.push({
              id,
              username: String(row.username || `imported_${id}`),
              passwordHash: hashed.hash,
              passwordSalt: hashed.salt,
              name: String(row.name || "Imported User"),
              email: String(row.email || `${id}@import.local`),
              role: String(row.role || "user") === "admin" ? "admin" : "user",
              enabled: String(row.enabled ?? "true") !== "false",
              accessKeys: [],
              departmentIds: [],
            });
          }
          imported += 1;
        }
      } else if (entity === "departments") {
        for (const row of rows) {
          const id = String(row.id || uuidv4());
          const existing = db.departments.find((d) => d.id === id || d.name === String(row.name || ""));
          if (existing) {
            existing.name = String(row.name || existing.name);
            existing.visibility = (row.visibility as any) || existing.visibility;
            existing.autoAssign = (row.auto_assign as any) || existing.autoAssign;
          } else {
            db.departments.push({
              id,
              name: String(row.name || "Imported Department"),
              subCategories: [],
              visibility: (row.visibility as any) || "all",
              autoAssign: (row.auto_assign as any) || null,
              accessTemplate: [],
              lastAssignedUserId: null,
            });
          }
          imported += 1;
        }
      } else {
        return res.status(400).json({ error: "Unsupported entity for import" });
      }

      const actor = getUserFromSession(req, db)!;
      addAuditLog(db, actor, {
        entityType: "settings",
        entityId: profileId,
        action: "SQL_IMPORT",
        details: `Imported ${imported} ${entity} rows from ${tableName}`,
      });
      writeDB(db);

      return res.json({ success: true, imported });
    } catch (err: any) {
      return res.status(400).json({ error: err?.message || "SQL import failed" });
    }
  });

  app.get("/api/audit-log", requireAuth, requirePermission("View Reports"), (req, res) => {
    const db = readDB();
    const limit = Math.min(Number(req.query.limit ?? 300), 1000);
    res.json(db.auditLog.slice(0, limit));
  });

  app.get("/api/notifications/overdue", requireAuth, (req, res) => {
    const db = readDB();
    const user = getUserFromSession(req, db)!;
    const now = Date.now();

    const visibleItems = db.workItems.filter((item) => canViewItem(user, item));
    const overdue = visibleItems.filter((item) => {
      if (item.status === "Closed" || item.status === "Cancelled" || item.status === "Archive") return false;
      const dueAt = new Date(item.createdAt).getTime() + db.settings.globalSLA * 60 * 60 * 1000;
      return dueAt < now;
    });

    res.json({
      count: overdue.length,
      items: overdue.slice(0, 20).map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status,
        departmentId: item.departmentId,
        creatorId: item.creatorId,
        assigneeId: item.assigneeId,
        createdAt: item.createdAt,
        hoursOverdue: Math.floor((now - (new Date(item.createdAt).getTime() + db.settings.globalSLA * 60 * 60 * 1000)) / (1000 * 60 * 60)),
      })),
    });
  });

  app.get("/api/reports", requireAuth, requirePermission("View Reports"), (req, res) => {
    const db = readDB();
    const filteredItems = buildFilteredWorkItems(db, req.query as Record<string, unknown>);

    const summary = {
      open: filteredItems.filter((i) => i.status === "Open").length,
      pending: filteredItems.filter((i) => i.status === "Pending").length,
      closed: filteredItems.filter((i) => i.status === "Closed").length,
      cancelled: filteredItems.filter((i) => i.status === "Cancelled").length,
      archived: filteredItems.filter((i) => i.status === "Archive").length,
    };

    const deptBreakdown = db.departments.map((d) => ({
      id: d.id,
      name: d.name,
      total: filteredItems.filter((i) => i.departmentId === d.id).length,
      closed: filteredItems.filter((i) => i.departmentId === d.id && i.status === "Closed").length,
    }));

    const agentPerformance = db.users.map((u) => ({
      id: u.id,
      name: u.name,
      created: filteredItems.filter((i) => i.creatorId === u.id).length,
      assigned: filteredItems.filter((i) => i.assigneeId === u.id).length,
      closed: filteredItems.filter((i) => i.assigneeId === u.id && i.status === "Closed").length,
    }));

    res.json({
      summary,
      deptBreakdown,
      agentPerformance,
      total: filteredItems.length,
      availableDepartments: db.departments,
      availableUsers: db.users.map((u) => ({ id: u.id, name: u.name, role: u.role })),
    });
  });

  app.get("/api/export/work-items", requireAuth, requirePermission("View Reports"), (req, res) => {
    const db = readDB();
    const filteredItems = buildFilteredWorkItems(db, req.query as Record<string, unknown>);
    const wb = XLSX.utils.book_new();

    const rows = filteredItems.map((item) => {
      const creator = db.users.find((u) => u.id === item.creatorId)?.name ?? item.creatorId;
      const assignee = db.users.find((u) => u.id === item.assigneeId)?.name ?? "Unassigned";
      const dept = db.departments.find((d) => d.id === item.departmentId)?.name ?? item.departmentId;
      const firstAssignedEvent = item.history.find((h) => h.action.includes("Assignment"));
      return {
        workItemId: item.id,
        title: item.title,
        description: item.description,
        status: item.status,
        creator,
        assignee,
        createdDepartment: dept,
        assignedDepartment: dept,
        subCategory: item.subCategory,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        slaHours: db.settings.globalSLA,
        timeOpenHours: calcHoursOpen(item.createdAt, item.updatedAt),
        firstAssignedAt: firstAssignedEvent?.timestamp ?? "",
        statusChanges: item.history
          .filter((h) => h.action === "Status Changed")
          .map((h) => `${h.timestamp}: ${h.details}`)
          .join(" | "),
        customFields: JSON.stringify(item.customFields),
        notesCount: item.notes.length,
        attachmentCount: item.attachments.length,
      };
    });

    const auditRows = db.auditLog
      .filter((a) => a.entityType === "work-item")
      .map((a) => ({
        timestamp: a.timestamp,
        workItemId: a.entityId,
        action: a.action,
        actor: a.actorName,
        details: a.details,
      }));

    const usersRows = db.users.map((u) => ({
      id: u.id,
      username: u.username,
      name: u.name,
      email: u.email,
      role: u.role,
      enabled: u.enabled,
      departments: (u.departmentIds || []).join(" | "),
      accessKeys: (u.accessKeys || []).join(" | "),
      lastLoginAt: u.lastLoginAt ?? "",
    }));

    const departmentsRows = db.departments.map((d) => ({
      id: d.id,
      name: d.name,
      visibility: d.visibility,
      autoAssign: d.autoAssign ?? "manual",
      accessTemplate: (d.accessTemplate || []).join(" | "),
      subCategories: JSON.stringify(d.subCategories || []),
    }));

    const historyRows = filteredItems.flatMap((item) =>
      (item.history || []).map((h) => ({
        workItemId: item.id,
        timestamp: h.timestamp,
        actorId: h.actorId,
        actorName: h.actorName,
        action: h.action,
        details: h.details,
      }))
    );

    const notesRows = filteredItems.flatMap((item) =>
      (item.notes || []).map((note) => ({
        workItemId: item.id,
        noteId: note.id,
        timestamp: note.timestamp,
        authorId: note.authorId,
        authorName: note.authorName,
        text: note.text,
      }))
    );

    const attachmentRows = filteredItems.flatMap((item) =>
      (item.attachments || []).map((file) => ({
        workItemId: item.id,
        attachmentId: file.id,
        filename: file.originalName,
        storedFilename: file.filename,
        mimetype: file.mimetype,
        sizeBytes: file.size,
        uploadedBy: file.uploadedBy,
        uploadedAt: file.timestamp,
      }))
    );

    const settingsRows = [
      {
        appName: db.settings.appName ?? "GML CRM",
        globalSlaHours: db.settings.globalSLA,
        dbProfiles: JSON.stringify(db.settings.dbProfiles || []),
      },
    ];

    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "WorkItemReport");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(auditRows), "AuditLog");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(historyRows), "WorkItemHistory");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(notesRows), "Notes");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(attachmentRows), "Attachments");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(usersRows), "Users");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(departmentsRows), "Departments");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(settingsRows), "Settings");

    const exportFilename = `slayr-work-items-${Date.now()}.xlsx`;
    const exportPath = path.join(EXPORT_DIR, exportFilename);
    XLSX.writeFile(wb, exportPath);
    res.download(exportPath, exportFilename, () => {
      if (fs.existsSync(exportPath)) {
        fs.unlink(exportPath, () => {});
      }
    });
  });

  // Legacy export alias kept for compatibility with older frontends.
  app.get("/api/export", requireAuth, requirePermission("View Reports"), (req, res) => {
    req.url = "/api/export/work-items";
    res.redirect(307, `/api/export/work-items?${new URLSearchParams(req.query as Record<string, string>).toString()}`);
  });

  app.get("/api/export/live-workbook", requireAuth, requirePermission("View Reports"), (_req, res) => {
    if (!fs.existsSync(LIVE_WORKBOOK_PATH)) {
      return res.status(404).json({ error: "Workbook not found" });
    }
    res.download(LIVE_WORKBOOK_PATH, "slayr-crm-data.xlsx");
  });

  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error.message.includes("Unsupported file type")) {
      return res.status(400).json({ error: "Unsupported file type" });
    }
    return res.status(500).json({ error: "Unexpected server error" });
  });

  const bootDb = readDB();
  writeDB(bootDb);

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Live workbook: ${LIVE_WORKBOOK_PATH}`);
  });
}

startServer();

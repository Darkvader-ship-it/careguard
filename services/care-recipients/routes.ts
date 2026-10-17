import { Router, type Request, type Response, type NextFunction } from "express";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { CareRecipientsStore, CareRecipientEntity } from "./db.ts";
import { registerKnownNames } from "../../shared/redact.ts";
import { createRateLimiter } from "../../shared/rate-limit.ts";
import { appendAuditEntry } from "../../shared/audit-log.ts";
import { loadRecipientAllergies } from "../../shared/allergies.ts";
import { readAdherenceRecords } from "../../shared/adherence.ts";
import { getMedicationHistory } from "../../shared/medication-history.ts";
import { logger } from "../../shared/logger.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = process.env.DATA_DIR || join(__dirname, "..", "..", "data");

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const list: Record<string, string> = {};
  if (!cookieHeader) return list;
  cookieHeader.split(";").forEach((cookie) => {
    const parts = cookie.split("=");
    list[parts.shift()!.trim()] = decodeURIComponent(parts.join("="));
  });
  return list;
}

export function requireCaregiverToken(caregiverToken: string) {
  return function (req: Request, res: Response, next: NextFunction) {
    const auth = req.headers.authorization;
    let token: string | undefined;

    if (auth?.startsWith("Bearer ")) {
      token = auth.slice("Bearer ".length);
    } else {
      const cookies = parseCookies(req.headers.cookie);
      token = cookies["caregiver_token"];

      if (token) {
        const csrfHeader = req.headers["x-csrf-token"];
        const csrfCookie = cookies["csrf_token"];
        if (!csrfHeader || !csrfCookie || csrfHeader !== csrfCookie) {
          res.status(403).json({ error: "CSRF token mismatch or missing" });
          return;
        }
      }
    }

    if (!token) {
      res.status(401).setHeader("WWW-Authenticate", "Bearer").json({ error: "Missing caregiver token" });
      return;
    }
    if (token !== caregiverToken) {
      res.status(403).json({ error: "Invalid caregiver token" });
      return;
    }
    next();
  };
}

/**
 * Care recipients CRUD & GDPR Data Export routes (Issue #1225).
 */
export function createCareRecipientsRouter(store: CareRecipientsStore, caregiverToken: string): Router {
  const router = Router();
  const auth = requireCaregiverToken(caregiverToken);
  const exportRateLimiter = createRateLimiter(
    "recipient-export",
    10,
    15 * 60 * 1000,
    { error: "Too many export requests, please try again later." },
  );

  router.get("/recipients", auth, (_req, res) => {
    res.json(store.list());
  });

  router.post("/recipients", auth, (req, res) => {
    const body = req.body as Partial<CareRecipientEntity>;
    if (!body?.name || typeof body.name !== "string" || !body.name.trim()) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const created = store.create({
      name: body.name.trim(),
      age: typeof body.age === "number" ? body.age : null,
      medications: Array.isArray(body.medications) ? body.medications : [],
      primary_doctor: typeof body.primary_doctor === "string" ? body.primary_doctor : null,
      insurance: typeof body.insurance === "string" ? body.insurance : null,
      caregiver_user_id: null,
    });
    registerKnownNames([created.name]);
    res.status(201).json(created);
  });

  // Handler for full recipient data takeout (Issue #1225)
  const handleExport = async (req: Request, res: Response) => {
    const recipientId = (req.params.id || (req.query.recipient_id as string) || (req.query.id as string) || "rosa").trim();
    
    // Resolve recipient entity from store or fallback
    let entity = store.getById(recipientId);
    if (!entity) {
      const all = store.list();
      entity = all.find(
        (r) => r.id.toLowerCase() === recipientId.toLowerCase() ||
               r.name.toLowerCase() === recipientId.toLowerCase()
      );
    }

    const cleanId = entity ? entity.id : recipientId;
    let recipientDir = join(DATA_DIR, "recipients", cleanId);
    if (!existsSync(recipientDir) && existsSync(join(DATA_DIR, "recipients", recipientId))) {
      recipientDir = join(DATA_DIR, "recipients", recipientId);
    }

    if (!entity) {
      if (existsSync(recipientDir)) {
        entity = {
          id: cleanId,
          name: cleanId.replace(/_/g, " "),
          age: null,
          medications: [],
          primary_doctor: null,
          insurance: null,
          caregiver_user_id: null,
        };
      } else {
        res.status(404).json({ error: `Care recipient '${recipientId}' not found` });
        return;
      }
    }

    // 1. Clean Recipient Info (strip internal DB fields such as caregiver_user_id)
    const cleanRecipient = {
      id: entity.id,
      name: entity.name,
      age: entity.age ?? null,
      primaryDoctor: entity.primary_doctor ?? null,
      insurance: entity.insurance ?? null,
    };

    // 2. Medications with dosage change history
    const cleanMedications = (entity.medications || []).map((medName) => {
      const history = getMedicationHistory(cleanId, medName);
      return {
        name: medName,
        dosage: history.length > 0 ? history[0].newDosage : "standard",
        frequency: history.length > 0 ? history[0].newFrequency : "daily",
        dosageHistory: history.map((h) => ({
          previousDosage: h.previousDosage,
          previousFrequency: h.previousFrequency,
          newDosage: h.newDosage,
          newFrequency: h.newFrequency,
          changedAt: h.changedAt,
          reason: h.reason,
          prescriber: h.prescriber,
        })),
      };
    });

    // 3. Spending Policy
    let cleanPolicy = {
      dailyLimit: 100,
      monthlyLimit: 800,
      medicationMonthlyBudget: 300,
      billMonthlyBudget: 500,
      approvalThreshold: 75,
      holdTimeSeconds: 86400,
      timezone: "America/Phoenix",
    };
    const policyFile = join(recipientDir, "policy.json");
    if (existsSync(policyFile)) {
      try {
        const rawPolicy = JSON.parse(readFileSync(policyFile, "utf-8"));
        cleanPolicy = { ...cleanPolicy, ...rawPolicy };
      } catch {
        // Fall back to clean defaults
      }
    }

    // 4. Transactions (strip internal lock tokens, system file paths, or extraction errors)
    let cleanTransactions: any[] = [];
    const txFile = join(recipientDir, "transactions.jsonl");
    if (existsSync(txFile)) {
      try {
        const content = readFileSync(txFile, "utf-8");
        cleanTransactions = content
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const raw = JSON.parse(line);
            return {
              id: raw.id,
              timestamp: raw.timestamp,
              type: raw.type,
              description: raw.description,
              amount: raw.amount,
              recipient: raw.recipient,
              stellarTxHash: raw.stellarTxHash,
              status: raw.status,
              category: raw.category,
            };
          });
      } catch {
        cleanTransactions = [];
      }
    }

    // 5. Orders
    let cleanOrders: any[] = [];
    const ordersFile = join(recipientDir, "orders.json");
    const globalOrdersFile = join(DATA_DIR, "orders.json");
    const targetOrdersFile = existsSync(ordersFile) ? ordersFile : globalOrdersFile;
    if (existsSync(targetOrdersFile)) {
      try {
        const rawOrders = JSON.parse(readFileSync(targetOrdersFile, "utf-8"));
        if (Array.isArray(rawOrders)) {
          cleanOrders = rawOrders.map((o: any) => ({
            orderId: o.orderId || o.id,
            drug: o.drug,
            pharmacy: o.pharmacy,
            amount: o.amount,
            status: o.status || "completed",
            createdAt: o.createdAt || o.timestamp,
            stellarTxHash: o.stellarTxHash,
          }));
        }
      } catch {
        cleanOrders = [];
      }
    }

    // 6. Documented Allergies
    const allergiesList = loadRecipientAllergies(cleanId).map((a) => ({
      substance: a.substance,
      severity: a.severity,
      reaction: a.reaction,
      notes: a.notes,
      createdAt: a.createdAt,
    }));

    // 7. Adherence Records
    const adherenceList = readAdherenceRecords()
      .filter((r) => r.recipientId === cleanId)
      .map((r) => ({
        drug: r.drug,
        dosage: r.dosage,
        pharmacy: r.pharmacy,
        dueDate: r.dueDate,
        status: r.status,
        confirmedAt: r.confirmedAt,
      }));

    // 8. Recipient Notes
    let notesList: any[] = [];
    const notesFile = join(recipientDir, "notes.json");
    if (existsSync(notesFile)) {
      try {
        const rawNotes = JSON.parse(readFileSync(notesFile, "utf-8"));
        if (Array.isArray(rawNotes)) {
          notesList = rawNotes.map((n: any) => ({
            id: n.id,
            title: n.title,
            content: n.content,
            createdAt: n.createdAt,
          }));
        }
      } catch {
        notesList = [];
      }
    }

    const exportBundle = {
      exportMetadata: {
        exportedAt: new Date().toISOString(),
        version: "1.0",
        recipientId: cleanId,
        format: "CareGuard GDPR Data Takeout",
      },
      recipient: cleanRecipient,
      medications: cleanMedications,
      policy: cleanPolicy,
      transactions: cleanTransactions,
      orders: cleanOrders,
      allergies: allergiesList,
      adherence: adherenceList,
      notes: notesList,
    };

    // Log export event to tamper-evident audit log
    appendAuditEntry({
      event: "recipient.data_exported",
      actor: "caregiver",
      details: {
        recipientId: cleanId,
        recipientName: cleanRecipient.name,
        transactionsCount: cleanTransactions.length,
        medicationsCount: cleanMedications.length,
        ordersCount: cleanOrders.length,
      },
    });

    logger.info(
      { recipientId: cleanId, transactions: cleanTransactions.length },
      "[care-recipients] completed recipient data export bundle",
    );

    res.setHeader("Content-Type", "application/json");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="careguard-export-${cleanId}-${new Date().toISOString().slice(0, 10)}.json"`,
    );
    res.status(200).json(exportBundle);
  };

  router.get("/recipients/export", auth, exportRateLimiter, handleExport);
  router.get("/recipients/:id/export", auth, exportRateLimiter, handleExport);

  return router;
}


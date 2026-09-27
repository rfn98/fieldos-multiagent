# FIELDOS

### AI operating system for field workers

**Omi input · Lyzr multi-agent reasoning · Qdrant operational memory · Deterministic actions**

FieldOS is an AI-powered operational assistant for field workers. It helps technicians investigate equipment problems, retrieve relevant operational history, reason over evidence, and execute constrained operational actions.

Instead of allowing an AI agent to directly modify operational data, FieldOS separates **reasoning from execution**:

> **Retrieve the right context. Reason over the evidence. Validate the decision. Execute the action deterministically.**

---

## Why FieldOS?

Field workers often have access to the information they need, but that information is distributed across multiple operational systems:

* Incident reports
* Maintenance records
* Work orders
* Standard operating procedures
* Equipment records
* Historical agent results

An equipment issue may require connecting information from several of these sources before a safe operational decision can be made.

FieldOS turns that fragmented workflow into a structured investigation:

```text
Field request
    ↓
Triage
    ↓
Asset resolution
    ↓
Qdrant memory retrieval
    ↓
Investigation
    ↓
Constrained action decision
    ↓
Deterministic execution
    ↓
Verification
    ↓
Operational memory
```

---

## What it does

A field worker can report an operational problem such as:

> **"Pump P-204 is vibrating again. The vibration feels stronger than yesterday."**

FieldOS processes the request through a multi-agent workflow.

The system can:

1. Identify the user's intent.
2. Resolve the referenced asset.
3. Retrieve relevant historical operational records.
4. Investigate the available evidence.
5. Determine an allowed operational action.
6. Validate the action against deterministic application rules.
7. Execute the action through Prisma/PostgreSQL.
8. Read the result back for verification.
9. Persist the verified result as operational memory.

For example, an investigation of **P-204 — Cooling Water Pump** can connect previous incidents, maintenance records, work orders, SOPs, and previous agent results.

The UI exposes the investigation trace, retrieved memories, agent decisions, deterministic action, and verification result rather than hiding the process behind a generic chatbot.

---

# Multi-Agent Architecture

FieldOS uses multiple specialized Lyzr agents rather than one unrestricted agent.

```text
                    Field Worker
                         │
                         ▼
                  Input / Omi layer
                         │
                         ▼
                 ┌───────────────┐
                 │    Triage     │
                 │     Agent     │
                 └───────┬───────┘
                         │
                         ▼
                  Asset Resolution
                         │
                         ▼
                 ┌───────────────┐
                 │    Qdrant     │
                 │    Memory     │
                 └───────┬───────┘
                         │
                         ▼
               ┌───────────────────┐
               │  Investigation    │
               │      Agent        │
               └─────────┬─────────┘
                         │
                         ▼
               ┌───────────────────┐
               │      Action       │
               │      Agent        │
               └─────────┬─────────┘
                         │
                         ▼
              Deterministic Validation
                         │
                         ▼
                  Prisma / PostgreSQL
                         │
                         ▼
                    Verification
                         │
                         ▼
                     Qdrant
```

The agents do not have unrestricted access to the database.

Lyzr agents produce structured decisions. FieldOS validates those decisions and performs database mutations through a deterministic application layer.

---

# Lyzr Integration

Lyzr provides the managed multi-agent reasoning layer.

FieldOS currently uses four specialized agents:

### Triage Agent

Determines:

* user intent
* referenced asset
* plant
* issue
* severity
* whether investigation is required
* whether clarification is needed

### Investigation Agent

Reasons over the retrieved operational evidence and produces:

* findings
* probable issue
* supporting evidence
* recommended action
* rationale
* existing work-order context

### Action Agent

Produces a strictly constrained action proposal such as:

```text
CREATE_WORK_ORDER
UPDATE_WORK_ORDER
ESCALATE_INCIDENT
RECORD_OBSERVATION
NO_ACTION
NEEDS_CLARIFICATION
```

The action is subsequently validated by FieldOS.

### Verification Agent

Reviews the result after the deterministic action has executed and produces a structured verification result.

---

## Agent Safety Boundary

The agents do **not** directly execute arbitrary SQL or Prisma operations.

The architecture is intentionally:

```text
Lyzr reasoning
      ↓
Structured JSON
      ↓
Zod validation
      ↓
Deterministic policy checks
      ↓
Allowed action
      ↓
Prisma
      ↓
Read-back verification
```

This creates a clear separation between:

**AI reasoning**

and

**operational execution**.

The AI can recommend an action, but the application remains authoritative over what can actually be executed.

---

# Qdrant Operational Memory

Qdrant is the semantic memory layer of FieldOS.

Operational records are indexed into the `fieldos-knowledge` collection using deterministic point IDs.

The indexed memory includes:

* Assets
* Incidents
* Maintenance records
* Work orders
* SOPs
* Agent results

The embedding model used by the current implementation is:

```text
Xenova/all-MiniLM-L6-v2
```

with:

```text
Dimensions: 384
Distance: cosine
```

Example memory identifiers include:

```text
asset:<uuid>
incident:<uuid>
maintenance:<uuid>
work-order:<uuid>
sop:<uuid>
agent-result:<action_type>:<action_uuid>
```

This allows FieldOS to retrieve historical operational context and also remember successfully verified agent results.

---

## Memory Flow

```text
PostgreSQL
    │
    ├── Assets
    ├── Incidents
    ├── Maintenance
    ├── Work Orders
    └── SOPs
    │
    ▼
Qdrant
    │
    ▼
Semantic retrieval
    │
    ▼
Investigation Agent
```

After a successful deterministic action and verification:

```text
Verified result
      ↓
Agent result memory
      ↓
Qdrant
```

This allows a later request to recall previous operational decisions without blindly repeating the original action.

For example:

```text
Request 1:
"Create a work order for P-204."

        ↓

Work order created
        ↓
Verified
        ↓
AGENT_RESULT persisted
```

A later request can retrieve that historical memory and inspect the current PostgreSQL state without creating another work order.

---

# Omi Integration

Omi is being used as the **field-worker voice/input layer**.

The current repository includes an Omi webhook and normalization layer:

```text
Omi transcript
      ↓
POST /api/omi/webhook
      ↓
normalizeOmiPayload()
      ↓
NormalizedOmiInput
```

The normalized input contains information such as:

```text
source
transcript
timestamp
sessionId
user metadata
transcript segments
event metadata
```

The current Omi implementation supports transcript events including realtime transcript and memory-style payloads.

### Current Omi Status

The Omi webhook and normalization layer are implemented, but the current MVP does **not yet directly invoke the FieldOS orchestrator from the Omi webhook**.

The current path is:

```text
Omi
  ↓
/api/omi/webhook
  ↓
normalizeOmiPayload()
  ↓
normalized FieldOS input
  ↓
handoff response
```

The final runtime wiring from this endpoint into the multi-agent orchestration workflow remains unfinished.

Authentication/signature verification for the Omi webhook is also not currently implemented.

Therefore, Omi should currently be considered a **partially integrated input layer**, not a fully live end-to-end voice workflow.

---

# Workflow Guardrails

FieldOS uses deterministic rules around the AI agents.

Examples include:

### Asset validation

The system resolves assets against PostgreSQL rather than trusting arbitrary asset names returned by an LLM.

### Evidence grounding

Investigation actions require sufficient retrieved evidence for report/issue workflows.

### Explicit action intent

If the field worker explicitly requests a work order, that intent is preserved as an application-level signal rather than relying solely on the LLM's action recommendation.

### Action validation

Only supported action types can reach the deterministic execution layer.

### Clarification

Ambiguous assets, plants, or required information can stop execution and request clarification.

### Read-back verification

After an action executes, FieldOS reads the resulting database state back before considering the operation successful.

---

# Example Workflow

Consider:

> **"Pump P-204 is vibrating again and needs inspection."**

The workflow becomes:

```text
1. Triage
   ↓
REPORT_ISSUE
P-204
   ↓
2. Asset Resolution
   ↓
P-204 → PostgreSQL
   ↓
3. Qdrant Retrieval
   ↓
Historical incidents
Maintenance
SOPs
Work orders
Agent results
   ↓
4. Investigation
   ↓
Evidence-grounded findings
   ↓
5. Action
   ↓
CREATE_WORK_ORDER
   ↓
6. Deterministic Validation
   ↓
7. PostgreSQL
   ↓
Work order created
   ↓
8. Verification
   ↓
Read-back confirmed
   ↓
9. Qdrant
   ↓
Verified agent result stored
```

The important distinction is that the LLM does not directly write the work order.

---

# Architecture

```text
┌───────────────────────────────────────────────┐
│                  FieldOS UI                   │
│                                               │
│ Asset Console · Investigation · Evidence      │
│ Agent Trace · Memory · Action · Verification  │
└───────────────────────┬───────────────────────┘
                        │
                        ▼
               ┌─────────────────┐
               │   Next.js API   │
               │    Workflow     │
               └────────┬────────┘
                        │
          ┌─────────────┼──────────────┐
          │             │              │
          ▼             ▼              ▼
      ┌────────┐   ┌──────────┐   ┌──────────┐
      │ Qdrant │   │  Lyzr    │   │PostgreSQL│
      │ Memory │   │  Agents  │   │  Source  │
      └────┬───┘   └────┬─────┘   │ of Truth │
           │             │         └────┬─────┘
           │             │              │
           └─────────────┼──────────────┘
                         │
                         ▼
              Deterministic Actions
                         │
                         ▼
                    Verification
```

---

# Data Responsibilities

FieldOS deliberately assigns different responsibilities to each system.

| System     | Responsibility                              |
| ---------- | ------------------------------------------- |
| PostgreSQL | Structured operational source of truth      |
| Prisma     | Database access and deterministic mutations |
| Qdrant     | Semantic operational memory                 |
| Lyzr       | Multi-agent reasoning                       |
| Omi        | Field-worker voice/input layer              |
| Next.js    | Application/API orchestration               |
| Zod        | Runtime contract validation                 |

No single component is responsible for the entire workflow.

---

# Tech Stack

### Frontend

* Next.js
* React
* TypeScript
* Tailwind CSS

### Backend

* Next.js App Router / API Routes
* Prisma
* PostgreSQL
* Zod

### AI / Agents

* Lyzr
* GPT-4o Mini
* Four specialized FieldOS agents
* Structured JSON contracts

### Memory / Retrieval

* Qdrant Cloud
* `Xenova/all-MiniLM-L6-v2`
* 384-dimensional embeddings
* Cosine similarity

### Voice / Input

* Omi webhook integration
* Omi transcript normalization
* Browser voice capabilities may still exist in legacy/demo code

---

# Project Structure

```text
fieldos-multi-agent/

├── app/
│   ├── api/
│   │   ├── assets/
│   │   ├── investigate/
│   │   └── omi/
│   │       └── webhook/
│   ├── layout.tsx
│   └── page.tsx
│
├── components/
│   ├── ActionPanel.tsx
│   ├── AgentPanel.tsx
│   ├── InputSourceBadge.tsx
│   ├── MemoryPanel.tsx
│   └── WorkflowTracePanel.tsx
│
├── lib/
│   ├── actions/
│   ├── omi/
│   ├── qdrant/
│   ├── workflow/
│   ├── types.ts
│   └── prisma.ts
│
├── prisma/
│   ├── schema.prisma
│   └── seed.ts
│
└── test/
    ├── workflow/
    └── verification-schema.test.ts
```

---

# Getting Started

## Requirements

* Node.js 22+
* PostgreSQL
* Qdrant Cloud account
* Lyzr account/API key

Omi is currently implemented as an HTTP webhook/normalization layer and does not require an Omi SDK dependency.

---

## 1. Install dependencies

```bash
npm install
```

---

## 2. Configure environment variables

Create `.env` with the variables required by the current application configuration.

At minimum, the application requires database, Qdrant, and Lyzr configuration.

Example:

```env
DATABASE_URL=your_postgresql_connection_string

QDRANT_URL=your_qdrant_url
QDRANT_API_KEY=your_qdrant_api_key
QDRANT_COLLECTION=fieldos-knowledge

LYZR_API_KEY=your_lyzr_api_key
LYZR_PROVIDER=lyzr
```

Do not commit real credentials.

---

## 3. Prepare the database

```bash
npx prisma migrate dev
```

Seed the demonstration dataset:

```bash
npx prisma db seed
```

---

## 4. Prepare Qdrant memory

The application uses the `fieldos-knowledge` Qdrant collection with 384-dimensional cosine embeddings.

Index the operational records using the repository's indexing scripts.

---

## 5. Start the application

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

---

# Example Investigation

Select:

**P-204 — Cooling Water Pump**

Then submit a field request such as:

> Why did P-204 fail before?

or:

> Pump P-204 is vibrating again. Investigate the issue.

FieldOS retrieves relevant operational memory, sends the evidence through the investigation workflow, and exposes the resulting reasoning, action decision, and verification trace.

---

# Design Principles

## Evidence before reasoning

AI reasoning should be grounded in retrieved operational context rather than invented context.

## Reasoning before execution

An LLM recommendation is not automatically an executable database operation.

## Deterministic execution

Operational mutations are performed by application-owned action handlers with explicit validation.

## Memory is separate from source of truth

Qdrant provides semantic recall.

PostgreSQL remains authoritative for current operational state.

## Specialized agents

Different workflow stages have different responsibilities instead of relying on a single unrestricted agent.

## Observable AI

FieldOS exposes the workflow trace, retrieved evidence, agent decisions, actions, and verification status.

## Fail closed

Malformed AI responses, invalid actions, insufficient evidence, ambiguous assets, and failed verification do not silently become successful operations.

---

# Current Limitations

This is a hackathon MVP focused on demonstrating grounded multi-agent field operations.

Current limitations include:

* Omi webhook normalization is implemented, but the webhook is not yet directly wired into the FieldOS orchestrator.
* Omi webhook authentication/signature verification is not yet implemented.
* Omi does not currently have a dedicated automated integration test suite.
* The demonstration dataset is intentionally small.
* Lyzr responses depend on the configured model/provider and network latency.
* Qdrant semantic memory uses local `Xenova/all-MiniLM-L6-v2` embeddings.
* The current implementation is demonstrated around industrial maintenance workflows.
* Some legacy voice/Moss/Ollama code may still exist from earlier iterations of the project but is not the primary architecture described above.

---

# Hackathon

Built for the **Lyzr × Qdrant × Omi hackathon — "Stop prompting. Code solo agents."**

FieldOS explores how multi-agent systems can assist workers operating in physical environments by combining:

```text
Field input
    ↓
Specialized agents
    ↓
Operational memory
    ↓
Evidence-grounded reasoning
    ↓
Deterministic execution
    ↓
Verification
```

The goal is not simply to build another conversational AI.

The goal is to build an operational system where AI reasoning is connected to real-world context while application-owned guardrails remain responsible for execution.

---

# License

This project is built as a hackathon prototype.
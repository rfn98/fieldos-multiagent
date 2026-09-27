-- ============================================================
-- FIELDOS DATABASE
-- PostgreSQL
-- ============================================================

DROP TABLE IF EXISTS maintenance_records CASCADE;
DROP TABLE IF EXISTS work_orders CASCADE;
DROP TABLE IF EXISTS incidents CASCADE;
DROP TABLE IF EXISTS sops CASCADE;
DROP TABLE IF EXISTS technicians CASCADE;
DROP TABLE IF EXISTS assets CASCADE;
DROP TABLE IF EXISTS plants CASCADE;


-- ============================================================
-- PLANTS
-- ============================================================

CREATE TABLE plants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(150) NOT NULL,
    location VARCHAR(150) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'operational',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================
-- ASSETS
-- ============================================================

CREATE TABLE assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plant_id UUID NOT NULL REFERENCES plants(id),

    asset_code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(150) NOT NULL,
    asset_type VARCHAR(80) NOT NULL,

    manufacturer VARCHAR(100),
    model VARCHAR(100),
    serial_number VARCHAR(100),

    location VARCHAR(150),
    status VARCHAR(30) NOT NULL DEFAULT 'operational',

    installed_at DATE,
    last_maintenance_at DATE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================
-- TECHNICIANS
-- ============================================================

CREATE TABLE technicians (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    employee_code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(150) NOT NULL,
    specialization VARCHAR(100),

    phone VARCHAR(50),
    status VARCHAR(30) NOT NULL DEFAULT 'available',

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================
-- INCIDENTS
-- ============================================================

CREATE TABLE incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    asset_id UUID NOT NULL REFERENCES assets(id),

    incident_code VARCHAR(50) NOT NULL UNIQUE,
    title VARCHAR(200) NOT NULL,
    description TEXT NOT NULL,

    severity VARCHAR(30) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'resolved',

    root_cause TEXT,
    resolution TEXT,

    occurred_at TIMESTAMPTZ NOT NULL,
    resolved_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================
-- MAINTENANCE RECORDS
-- ============================================================

CREATE TABLE maintenance_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    asset_id UUID NOT NULL REFERENCES assets(id),
    technician_id UUID REFERENCES technicians(id),

    record_code VARCHAR(50) NOT NULL UNIQUE,

    maintenance_type VARCHAR(50) NOT NULL,
    description TEXT NOT NULL,

    findings TEXT,
    action_taken TEXT,
    parts_replaced TEXT,

    maintenance_date TIMESTAMPTZ NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================
-- WORK ORDERS
-- ============================================================

CREATE TABLE work_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    asset_id UUID NOT NULL REFERENCES assets(id),
    technician_id UUID REFERENCES technicians(id),

    work_order_code VARCHAR(50) NOT NULL UNIQUE,

    title VARCHAR(200) NOT NULL,
    description TEXT,

    priority VARCHAR(30) NOT NULL DEFAULT 'medium',
    status VARCHAR(30) NOT NULL DEFAULT 'open',

    scheduled_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================
-- SOPS
-- ============================================================

CREATE TABLE sops (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    asset_id UUID REFERENCES assets(id),

    sop_code VARCHAR(50) NOT NULL UNIQUE,
    title VARCHAR(200) NOT NULL,

    category VARCHAR(100),
    version VARCHAR(30),

    content TEXT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX idx_assets_plant
    ON assets(plant_id);

CREATE INDEX idx_incidents_asset
    ON incidents(asset_id);

CREATE INDEX idx_maintenance_asset
    ON maintenance_records(asset_id);

CREATE INDEX idx_work_orders_asset
    ON work_orders(asset_id);

CREATE INDEX idx_work_orders_technician
    ON work_orders(technician_id);

CREATE INDEX idx_sops_asset
    ON sops(asset_id);


-- ============================================================
-- SEED: PLANTS
-- ============================================================

INSERT INTO plants
    (code, name, location, status)
VALUES
    (
        'PLANT-A',
        'Cikarang Manufacturing Plant',
        'Cikarang, West Java',
        'operational'
    ),
    (
        'PLANT-B',
        'Bekasi Processing Plant',
        'Bekasi, West Java',
        'operational'
    );


-- ============================================================
-- SEED: ASSETS
-- ============================================================

INSERT INTO assets
    (
        plant_id,
        asset_code,
        name,
        asset_type,
        manufacturer,
        model,
        serial_number,
        location,
        status,
        installed_at,
        last_maintenance_at
    )
VALUES

-- P-204
(
    (SELECT id FROM plants WHERE code = 'PLANT-A'),
    'P-204',
    'Cooling Water Pump',
    'Pump',
    'Grundfos',
    'CR 32-4',
    'GR-P204-2021-0042',
    'Utility Area - North',
    'critical',
    '2021-03-15',
    '2026-08-28'
),

-- P-201
(
    (SELECT id FROM plants WHERE code = 'PLANT-A'),
    'P-201',
    'Feed Water Pump',
    'Pump',
    'KSB',
    'Etanorm 50-32',
    'KSB-P201-2020-0081',
    'Utility Area - South',
    'operational',
    '2020-07-12',
    '2026-08-20'
),

-- M-101
(
    (SELECT id FROM plants WHERE code = 'PLANT-A'),
    'M-101',
    'Main Air Compressor',
    'Compressor',
    'Atlas Copco',
    'GA 75',
    'AC-M101-2019-0214',
    'Compressor Room',
    'operational',
    '2019-11-03',
    '2026-08-18'
),

-- M-103
(
    (SELECT id FROM plants WHERE code = 'PLANT-A'),
    'M-103',
    'Cooling Tower Motor',
    'Motor',
    'ABB',
    'M3BP 250',
    'ABB-M103-2022-0312',
    'Cooling Tower',
    'warning',
    '2022-02-21',
    '2026-08-25'
),

-- V-301
(
    (SELECT id FROM plants WHERE code = 'PLANT-A'),
    'V-301',
    'Process Control Valve',
    'Control Valve',
    'Fisher',
    'D4',
    'FS-V301-2023-0098',
    'Process Line 3',
    'operational',
    '2023-04-10',
    '2026-08-22'
),

-- P-305
(
    (SELECT id FROM plants WHERE code = 'PLANT-B'),
    'P-305',
    'Chemical Transfer Pump',
    'Pump',
    'Sulzer',
    'AHLSTAR',
    'SZ-P305-2021-0144',
    'Chemical Area',
    'operational',
    '2021-09-18',
    '2026-08-19'
);


-- ============================================================
-- SEED: TECHNICIANS
-- ============================================================

INSERT INTO technicians
    (
        employee_code,
        name,
        specialization,
        phone,
        status
    )
VALUES
(
    'TECH-001',
    'Andi Pratama',
    'Mechanical',
    '+62-811-1001-001',
    'available'
),
(
    'TECH-002',
    'Budi Santoso',
    'Electrical',
    '+62-811-1001-002',
    'available'
),
(
    'TECH-003',
    'Rizky Maulana',
    'Instrumentation',
    '+62-811-1001-003',
    'on-site'
),
(
    'TECH-004',
    'Dimas Saputra',
    'Mechanical',
    '+62-811-1001-004',
    'available'
);


-- ============================================================
-- SEED: INCIDENTS
-- ============================================================

INSERT INTO incidents
    (
        asset_id,
        incident_code,
        title,
        description,
        severity,
        status,
        root_cause,
        resolution,
        occurred_at,
        resolved_at
    )
VALUES

(
    (SELECT id FROM assets WHERE asset_code = 'P-204'),
    'INC-2026-001',
    'Abnormal vibration detected',
    'P-204 developed abnormal vibration during operation. Vibration increased gradually over approximately two hours.',
    'high',
    'resolved',
    'Partial obstruction in the intake filter caused restricted water flow and pump imbalance.',
    'Intake filter was removed and cleaned. Gasket was replaced before returning the pump to service.',
    '2026-08-14 09:20:00+07',
    '2026-08-14 14:45:00+07'
),

(
    (SELECT id FROM assets WHERE asset_code = 'P-204'),
    'INC-2026-002',
    'Unexpected pump shutdown',
    'P-204 stopped unexpectedly during normal operation. Motor protection was triggered after abnormal load was detected.',
    'critical',
    'resolved',
    'Heavy contamination of the intake filter caused restricted flow. The same failure pattern was observed during INC-2026-001.',
    'Filter housing was cleaned, filter element replaced, and pump alignment was verified.',
    '2026-08-28 07:35:00+07',
    '2026-08-28 13:10:00+07'
),

(
    (SELECT id FROM assets WHERE asset_code = 'M-103'),
    'INC-2026-003',
    'Motor temperature above normal',
    'Cooling tower motor M-103 reached a temperature above its normal operating range.',
    'medium',
    'resolved',
    'Cooling fan airflow was reduced because of dust accumulation.',
    'Cooling fan was cleaned and bearing lubrication was performed.',
    '2026-08-25 11:10:00+07',
    '2026-08-25 15:20:00+07'
),

(
    (SELECT id FROM assets WHERE asset_code = 'P-201'),
    'INC-2026-004',
    'Low discharge pressure',
    'P-201 showed lower than expected discharge pressure during startup.',
    'medium',
    'resolved',
    'Air trapped inside the pump casing after maintenance.',
    'Pump was vented and restarted. Discharge pressure returned to normal.',
    '2026-08-20 08:15:00+07',
    '2026-08-20 09:05:00+07'
);


-- ============================================================
-- SEED: MAINTENANCE RECORDS
-- ============================================================

INSERT INTO maintenance_records
    (
        asset_id,
        technician_id,
        record_code,
        maintenance_type,
        description,
        findings,
        action_taken,
        parts_replaced,
        maintenance_date
    )
VALUES

(
    (SELECT id FROM assets WHERE asset_code = 'P-204'),
    (SELECT id FROM technicians WHERE employee_code = 'TECH-001'),
    'MNT-2026-001',
    'Corrective',
    'Inspection after abnormal vibration.',
    'Intake filter contained significant debris and flow restriction was observed.',
    'Cleaned intake filter and inspected pump alignment.',
    'Filter gasket',
    '2026-08-14 14:00:00+07'
),

(
    (SELECT id FROM assets WHERE asset_code = 'P-204'),
    (SELECT id FROM technicians WHERE employee_code = 'TECH-004'),
    'MNT-2026-002',
    'Corrective',
    'Emergency maintenance following unexpected shutdown.',
    'Heavy contamination found in intake filter. Pump alignment remained within tolerance.',
    'Replaced filter element, cleaned housing and verified alignment.',
    'Filter element, gasket',
    '2026-08-28 12:30:00+07'
),

(
    (SELECT id FROM assets WHERE asset_code = 'P-201'),
    (SELECT id FROM technicians WHERE employee_code = 'TECH-001'),
    'MNT-2026-003',
    'Preventive',
    'Monthly pump inspection.',
    'No abnormal vibration. Coupling and seals were within acceptable condition.',
    'Performed lubrication and vibration check.',
    NULL,
    '2026-08-20 10:00:00+07'
),

(
    (SELECT id FROM assets WHERE asset_code = 'M-103'),
    (SELECT id FROM technicians WHERE employee_code = 'TECH-002'),
    'MNT-2026-004',
    'Preventive',
    'Cooling tower motor inspection.',
    'Dust accumulation found around cooling fan.',
    'Cleaned cooling fan and lubricated motor bearings.',
    NULL,
    '2026-08-25 15:00:00+07'
);


-- ============================================================
-- SEED: WORK ORDERS
-- ============================================================

INSERT INTO work_orders
    (
        asset_id,
        technician_id,
        work_order_code,
        title,
        description,
        priority,
        status,
        scheduled_at,
        completed_at
    )
VALUES

(
    (SELECT id FROM assets WHERE asset_code = 'P-204'),
    (SELECT id FROM technicians WHERE employee_code = 'TECH-004'),
    'WO-2026-001',
    'Inspect P-204 intake system',
    'Inspect intake filter, differential pressure and pump vibration.',
    'critical',
    'completed',
    '2026-08-28 08:00:00+07',
    '2026-08-28 13:10:00+07'
),

(
    (SELECT id FROM assets WHERE asset_code = 'M-103'),
    (SELECT id FROM technicians WHERE employee_code = 'TECH-002'),
    'WO-2026-002',
    'Cooling tower motor inspection',
    'Inspect motor temperature, bearings and cooling airflow.',
    'medium',
    'completed',
    '2026-08-25 10:00:00+07',
    '2026-08-25 15:20:00+07'
),

(
    (SELECT id FROM assets WHERE asset_code = 'P-201'),
    (SELECT id FROM technicians WHERE employee_code = 'TECH-001'),
    'WO-2026-003',
    'Monthly preventive maintenance',
    'Perform scheduled monthly inspection.',
    'low',
    'completed',
    '2026-08-20 09:00:00+07',
    '2026-08-20 10:30:00+07'
),

(
    (SELECT id FROM assets WHERE asset_code = 'P-204'),
    (SELECT id FROM technicians WHERE employee_code = 'TECH-001'),
    'WO-2026-004',
    'Follow-up inspection',
    'Verify intake filter condition after repeated failures.',
    'high',
    'open',
    '2026-09-08 08:00:00+07',
    NULL
);


-- ============================================================
-- SEED: SOPS
-- ============================================================

INSERT INTO sops
    (
        asset_id,
        sop_code,
        title,
        category,
        version,
        content
    )
VALUES

(
    (SELECT id FROM assets WHERE asset_code = 'P-204'),
    'SOP-014',
    'P-204 Intake Filter Inspection Procedure',
    'Inspection',
    '3.1',
    'Before inspecting the P-204 intake filter, perform lockout/tagout and confirm the pump is isolated from the process. Close the intake valve before opening the filter housing. Check differential pressure across the filter. Inspect the filter element for debris, contamination and physical damage. Clean or replace the filter element if contamination exceeds the acceptable threshold. Verify gasket condition before reassembly. After reassembly, verify pump vibration and discharge pressure.'
),

(
    (SELECT id FROM assets WHERE asset_code = 'P-204'),
    'SOP-015',
    'P-204 Pump Restart Procedure',
    'Operation',
    '2.4',
    'After maintenance, verify that the intake valve is open, the filter housing is properly sealed and the pump is correctly aligned. Start the pump and monitor vibration, discharge pressure and motor current for the first ten minutes.'
),

(
    (SELECT id FROM assets WHERE asset_code = 'M-103'),
    'SOP-022',
    'Cooling Tower Motor Inspection',
    'Inspection',
    '1.8',
    'Inspect motor temperature, bearing condition and cooling fan airflow. Remove dust accumulation from cooling surfaces. Verify bearing lubrication according to the manufacturer maintenance interval.'
),

(
    (SELECT id FROM assets WHERE asset_code = 'P-201'),
    'SOP-018',
    'Feed Pump Startup Procedure',
    'Operation',
    '2.1',
    'Before startup, verify that the pump casing is filled and vented. Open the suction valve and confirm discharge path availability. Start the pump and verify discharge pressure remains within the normal operating range.'
);


-- ============================================================
-- QUICK VERIFICATION
-- ============================================================

SELECT 'plants' AS table_name, COUNT(*) AS records FROM plants
UNION ALL
SELECT 'assets', COUNT(*) FROM assets
UNION ALL
SELECT 'technicians', COUNT(*) FROM technicians
UNION ALL
SELECT 'incidents', COUNT(*) FROM incidents
UNION ALL
SELECT 'maintenance_records', COUNT(*) FROM maintenance_records
UNION ALL
SELECT 'work_orders', COUNT(*) FROM work_orders
UNION ALL
SELECT 'sops', COUNT(*) FROM sops;
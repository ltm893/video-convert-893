"use strict";

const PLACEHOLDER_ID = "your-id-here";
const PLACEHOLDER_TABLE = "your-id-here-calendar";

function resolveId(localId, baseId) {
  const local = String(localId ?? "").trim();
  if (local && local !== PLACEHOLDER_ID) return local;
  const base = String(baseId ?? "").trim();
  if (!base || base === PLACEHOLDER_ID) {
    throw new Error("Set id in cognito-s3-stack-893/base/bin/config.ts");
  }
  return base;
}

function resolveRegion(localRegion, baseRegion) {
  const local = String(localRegion ?? "").trim();
  if (local) return local;
  const base = String(baseRegion ?? "").trim();
  if (!base) {
    throw new Error("Set awsRegion in cognito-s3-stack-893/base/bin/config.ts");
  }
  return base;
}

function resolveCalendarTable(id, calendarTable) {
  const table = String(calendarTable ?? "").trim();
  if (!table || table === PLACEHOLDER_TABLE) return `${id}-calendar`;
  return table;
}

function resolveCreateTable(value) {
  if (value === undefined || value === null) return true;
  return value === true;
}

module.exports = {
  resolveId,
  resolveRegion,
  resolveCalendarTable,
  resolveCreateTable,
};

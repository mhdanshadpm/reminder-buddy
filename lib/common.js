'use strict';

class ValidationError extends Error {
  constructor(errors) {
    super(errors[0] || 'Invalid data');
    this.name = 'ValidationError';
    this.errors = Array.isArray(errors) ? errors : [String(errors)];
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function parseClock(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function formatClock(minutes) {
  if (!Number.isFinite(minutes)) return '';
  const normalized = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(normalized / 60))}:${pad2(normalized % 60)}`;
}

function dateKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function isDateKey(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseDateKey(value) {
  if (!isDateKey(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

function localDayStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function addDays(date, amount) {
  const result = new Date(date);
  result.setDate(result.getDate() + amount);
  return result;
}

function atClock(dayStart, minutes) {
  const hours = Math.floor(minutes / 60);
  const minutesPart = minutes % 60;
  return new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate(), hours, minutesPart, 0, 0);
}

function parseLocalDateTime(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const [year, month, day, hours, minutes, seconds] = match.slice(1).map((part) => Number(part || 0));
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  const date = new Date(year, month - 1, day, hours, minutes, seconds, 0);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
    || date.getHours() !== hours
    || date.getMinutes() !== minutes
  ) {
    return null;
  }
  return date;
}

function localDateTimeString(date) {
  return `${dateKey(date)}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function isValidIdentifier(value, maxLength = 80) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
}

function createId(prefix = 'r') {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sameIdentifier(left, right) {
  return String(left || '').toLocaleLowerCase() === String(right || '').toLocaleLowerCase();
}

function sortedUniqueDays(value) {
  if (!Array.isArray(value)) return null;
  const unique = [...new Set(value)];
  if (unique.length === 0) return null;
  if (!unique.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)) return null;
  return unique.sort((left, right) => left - right);
}

const ALL_DAYS = Object.freeze([0, 1, 2, 3, 4, 5, 6]);
const WEEKDAYS = Object.freeze([1, 2, 3, 4, 5]);
const WEEKEND_DAYS = Object.freeze([0, 6]);

module.exports = {
  ALL_DAYS,
  ValidationError,
  WEEKDAYS,
  WEEKEND_DAYS,
  addDays,
  atClock,
  clamp,
  createId,
  dateKey,
  deepClone,
  formatClock,
  isDateKey,
  isPlainObject,
  isValidIdentifier,
  localDateTimeString,
  localDayStart,
  pad2,
  parseClock,
  parseDateKey,
  parseLocalDateTime,
  sameIdentifier,
  sortedUniqueDays
};

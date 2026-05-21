// Mock VIN lookup database — stands in for the Salesforce
// /apex/chatbot/lookup-vin endpoint until the real integration goes live.
//
// Eight seeded Jeep MA records. When the customer enters a known VIN during
// the RDV / Réclamation flow, the agent pre-fills name + email + phone and
// confirms with them before continuing — proposition #2 in the Stellantis
// brief, which is the strongest UX moment for returning customers.
//
// VIN format reminder (validated separately in lib/vin.ts):
//   17 chars · alphanumeric (A-Z, 0-9). No forbidden-letter rule.

import { normalizeVin } from "./vin";

export type VinRecord = {
  vin: string;
  fullName: string;
  email: string;
  phone: string;            // canonical international form
  brand: string;            // 'Jeep' / 'Citroën' / 'Peugeot' / etc.
  model: string;
  modelYear: number;
  registrationCity: string;
  lastServiceDate: string | null;        // ISO date
  lastServiceLocation: string | null;
  preferredSite: string | null;          // dealer they usually visit
};

const SEED: VinRecord[] = [
  {
    vin: "1C4HJWAG6JL811234",
    fullName: "Aymane Bennani",
    email: "aymane.bennani@example.ma",
    phone: "+212 661 22 33 44",
    brand: "Jeep",
    model: "Wrangler",
    modelYear: 2022,
    registrationCity: "Casablanca",
    lastServiceDate: "2025-11-12",
    lastServiceLocation: "Jeep Casablanca Anfa",
    preferredSite: "Jeep Casablanca Anfa",
  },
  {
    vin: "1C4PJMCB5KW569012",
    fullName: "Sara El Mansouri",
    email: "sara.elmansouri@example.ma",
    phone: "+212 670 11 22 99",
    brand: "Jeep",
    model: "Cherokee",
    modelYear: 2023,
    registrationCity: "Rabat",
    lastServiceDate: "2026-01-08",
    lastServiceLocation: "Jeep Rabat Hay Riad",
    preferredSite: "Jeep Rabat Hay Riad",
  },
  {
    vin: "1C4RJFAG3MC234567",
    fullName: "Karim Tazi",
    email: "k.tazi@example.ma",
    phone: "+212 668 50 70 80",
    brand: "Jeep",
    model: "Grand Cherokee",
    modelYear: 2024,
    registrationCity: "Marrakech",
    lastServiceDate: "2025-09-22",
    lastServiceLocation: "Jeep Marrakech Sidi Ghanem",
    preferredSite: "Jeep Marrakech Sidi Ghanem",
  },
  {
    vin: "1C4HJXFG5NW780123",
    fullName: "Yassine Alaoui",
    email: "yassine.alaoui@example.ma",
    phone: "+212 612 88 77 66",
    brand: "Jeep",
    model: "Wrangler",
    modelYear: 2024,
    registrationCity: "Tanger",
    lastServiceDate: null,
    lastServiceLocation: null,
    preferredSite: "Jeep Tanger",
  },
  {
    vin: "1C4PJMABXLD345678",
    fullName: "Nadia Benkirane",
    email: "nadia.benkirane@example.ma",
    phone: "+212 663 14 25 36",
    brand: "Jeep",
    model: "Compass",
    modelYear: 2023,
    registrationCity: "Casablanca",
    lastServiceDate: "2025-12-04",
    lastServiceLocation: "Jeep Casablanca Ain Sebaâ",
    preferredSite: "Jeep Casablanca Ain Sebaâ",
  },
  {
    vin: "ZACPJBBB7KP890123",
    fullName: "Hamza Idrissi",
    email: "hamza.idrissi@example.ma",
    phone: "+212 661 99 88 77",
    brand: "Jeep",
    model: "Renegade",
    modelYear: 2022,
    registrationCity: "Fès",
    lastServiceDate: "2025-10-15",
    lastServiceLocation: "Jeep Fès",
    preferredSite: "Jeep Fès",
  },
  {
    vin: "1C4RJFCG3JC456789",
    fullName: "Imane Lahlou",
    email: "imane.lahlou@example.ma",
    phone: "+212 670 33 44 55",
    brand: "Jeep",
    model: "Grand Cherokee",
    modelYear: 2021,
    registrationCity: "Agadir",
    lastServiceDate: "2025-08-30",
    lastServiceLocation: "Jeep Agadir",
    preferredSite: "Jeep Agadir",
  },
  {
    vin: "1C4PJMDS6LD012345",
    fullName: "Mehdi Cherkaoui",
    email: "mehdi.cherkaoui@example.ma",
    phone: "+212 612 50 60 70",
    brand: "Jeep",
    model: "Cherokee",
    modelYear: 2024,
    registrationCity: "Rabat",
    lastServiceDate: null,
    lastServiceLocation: null,
    preferredSite: "Jeep Rabat Souissi",
  },
];

const INDEX = new Map<string, VinRecord>(SEED.map((r) => [r.vin, r]));

export function lookupVin(rawVin: string): VinRecord | null {
  if (!rawVin) return null;
  const v = normalizeVin(rawVin);
  if (v.length !== 17) return null;
  return INDEX.get(v) ?? null;
}

/**
 * Static geographic reference — the sort of lookup an acquirer buys from a geolocation
 * vendor. It says where cities are, never who is suspicious, which is why both the
 * generator and the investigation path may import it.
 *
 * Coordinates are integer microdegrees so every derived value stays canonicalisable.
 */

const MICRODEGREES = 1_000_000;
const EARTH_RADIUS_KM = 6_371;

export interface City {
  readonly name: string;
  readonly country: string;
  readonly latitudeUdeg: number;
  readonly longitudeUdeg: number;
  /** Rough population weight; metro concentration is what makes shared NATs plausible. */
  readonly weight: number;
}

export const CITIES: readonly City[] = [
  {
    name: "Bengaluru",
    country: "IN",
    latitudeUdeg: 12_971_599,
    longitudeUdeg: 77_594_566,
    weight: 190,
  },
  {
    name: "Mumbai",
    country: "IN",
    latitudeUdeg: 19_075_984,
    longitudeUdeg: 72_877_656,
    weight: 180,
  },
  {
    name: "Delhi",
    country: "IN",
    latitudeUdeg: 28_704_060,
    longitudeUdeg: 77_102_493,
    weight: 165,
  },
  {
    name: "Hyderabad",
    country: "IN",
    latitudeUdeg: 17_385_044,
    longitudeUdeg: 78_486_671,
    weight: 110,
  },
  {
    name: "Chennai",
    country: "IN",
    latitudeUdeg: 13_082_680,
    longitudeUdeg: 80_270_718,
    weight: 100,
  },
  { name: "Pune", country: "IN", latitudeUdeg: 18_520_430, longitudeUdeg: 73_856_744, weight: 85 },
  {
    name: "Kolkata",
    country: "IN",
    latitudeUdeg: 22_572_646,
    longitudeUdeg: 88_363_895,
    weight: 80,
  },
  {
    name: "Ahmedabad",
    country: "IN",
    latitudeUdeg: 23_022_505,
    longitudeUdeg: 72_571_362,
    weight: 65,
  },
  {
    name: "Jaipur",
    country: "IN",
    latitudeUdeg: 26_912_434,
    longitudeUdeg: 75_787_270,
    weight: 45,
  },
  {
    name: "Lucknow",
    country: "IN",
    latitudeUdeg: 26_846_694,
    longitudeUdeg: 80_946_166,
    weight: 40,
  },
  { name: "Surat", country: "IN", latitudeUdeg: 21_170_240, longitudeUdeg: 72_831_061, weight: 38 },
  {
    name: "Indore",
    country: "IN",
    latitudeUdeg: 22_719_569,
    longitudeUdeg: 75_857_726,
    weight: 32,
  },
  {
    name: "Nagpur",
    country: "IN",
    latitudeUdeg: 21_145_800,
    longitudeUdeg: 79_088_155,
    weight: 30,
  },
  { name: "Kochi", country: "IN", latitudeUdeg: 9_931_233, longitudeUdeg: 76_267_303, weight: 28 },
  {
    name: "Chandigarh",
    country: "IN",
    latitudeUdeg: 30_733_315,
    longitudeUdeg: 76_779_418,
    weight: 24,
  },
  {
    name: "Guwahati",
    country: "IN",
    latitudeUdeg: 26_144_518,
    longitudeUdeg: 91_736_237,
    weight: 20,
  },
  // Destinations that make travel decoys plausible rather than absurd.
  { name: "Dubai", country: "AE", latitudeUdeg: 25_204_849, longitudeUdeg: 55_270_783, weight: 12 },
  {
    name: "Singapore",
    country: "SG",
    latitudeUdeg: 1_352_083,
    longitudeUdeg: 103_819_836,
    weight: 10,
  },
  {
    name: "Bangkok",
    country: "TH",
    latitudeUdeg: 13_756_331,
    longitudeUdeg: 100_501_765,
    weight: 8,
  },
  { name: "London", country: "GB", latitudeUdeg: 51_507_351, longitudeUdeg: -127_758, weight: 7 },
  { name: "Colombo", country: "LK", latitudeUdeg: 6_927_079, longitudeUdeg: 79_861_243, weight: 5 },
  {
    name: "New York",
    country: "US",
    latitudeUdeg: 40_712_776,
    longitudeUdeg: -74_005_974,
    weight: 5,
  },
];

export const CITIES_BY_NAME: ReadonlyMap<string, City> = new Map(
  CITIES.map((city) => [city.name, city]),
);

export const INDIAN_CITIES: readonly City[] = CITIES.filter((city) => city.country === "IN");

const MAX_PLAUSIBLE_SPEED_KMH = 900;

/**
 * Slack absorbing airport transfers, check-in and geolocation error — roughly an hour
 * at each end. Calibrated against a real itinerary: Bengaluru to Delhi in four hours is
 * an ordinary domestic flight and must not fire. The check is biased towards
 * under-firing on purpose: it should mean "no journey exists", not "that was quick",
 * because the finding it feeds is weighted as strong evidence.
 */
const TRAVEL_GRACE_MINUTES = 120;

export function distanceKm(origin: string, destination: string): number | null {
  const start = CITIES_BY_NAME.get(origin);
  const end = CITIES_BY_NAME.get(destination);
  if (!start || !end) return null;
  const lat1 = (start.latitudeUdeg / MICRODEGREES) * (Math.PI / 180);
  const lat2 = (end.latitudeUdeg / MICRODEGREES) * (Math.PI / 180);
  const dLat = lat2 - lat1;
  const dLon = ((end.longitudeUdeg - start.longitudeUdeg) / MICRODEGREES) * (Math.PI / 180);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h)));
}

export function minimumTravelMinutes(origin: string, destination: string): number | null {
  const distance = distanceKm(origin, destination);
  if (distance === null) return null;
  if (distance === 0) return 0;
  return Math.floor((distance * 60) / MAX_PLAUSIBLE_SPEED_KMH) + TRAVEL_GRACE_MINUTES;
}

/**
 * `null` means undecidable — an unknown city on either end. Callers must not read that
 * as `false`: suppressing geolocation is the cheapest way to defeat this check, so
 * absence of evidence has to stay absent rather than becoming exculpatory.
 */
export function isTravelImplausible(
  origin: string,
  destination: string,
  elapsedMinutes: number,
): boolean | null {
  const required = minimumTravelMinutes(origin, destination);
  if (required === null) return null;
  return elapsedMinutes < required;
}

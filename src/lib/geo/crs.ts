import proj4 from 'proj4';

/** TWD97 / TM2 zone 121（EPSG:3826） */
const EPSG3826 =
  '+proj=tmerc +lat_0=0 +lon_0=121 +k=0.9999 +x_0=250000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';

proj4.defs('EPSG:3826', EPSG3826);

/** [lon, lat] → [E, N] */
export function wgs84ToTwd97(lonLat: [number, number]): [number, number] {
  const [e, n] = proj4('EPSG:4326', 'EPSG:3826', lonLat);
  return [e!, n!];
}

/** [E, N] → [lon, lat] */
export function twd97ToWgs84(en: [number, number]): [number, number] {
  const [lon, lat] = proj4('EPSG:3826', 'EPSG:4326', en);
  return [lon!, lat!];
}

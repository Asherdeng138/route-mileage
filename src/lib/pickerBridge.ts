/** 「在地图上选择地点」页面把结果交回调用页面（同一进程内的一次性传递） */
export interface PickedPlace {
  name: string;
  address: string | null;
  lat: number;
  lng: number;
}

const results = new Map<string, PickedPlace>();

export const putPick = (key: string, p: PickedPlace) => {
  results.set(key, p);
};

export function takePick(key: string): PickedPlace | null {
  const p = results.get(key) ?? null;
  results.delete(key);
  return p;
}

import { useId } from 'react';

/** The Multimodel mark: an M drawn as a small graph, several model nodes joined at one hub. Mirrors public/icon.svg. */
export default function Logo({size=20,framed=true}:{size?:number;framed?:boolean}) {
  const g=`mm-${useId().replace(/:/g,'')}`;
  return <svg className="logo" width={size} height={size} viewBox="0 0 256 256" aria-hidden="true" focusable="false">
    <defs><linearGradient id={g} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#8cb7df"/><stop offset="1" stopColor="#b59fcc"/></linearGradient></defs>
    {framed&&<rect x="8" y="8" width="240" height="240" rx="56" fill="#16191d" stroke="#3a4552" strokeWidth="6"/>}
    <polyline points="64,184 64,76 128,150 192,76 192,184" fill="none" stroke={`url(#${g})`} strokeWidth="20" strokeLinecap="round" strokeLinejoin="round"/>
    <g fill="#16191d" stroke={`url(#${g})`} strokeWidth="12">{[[64,76],[192,76],[64,184],[192,184]].map(([cx,cy])=><circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="16"/>)}</g>
    <circle cx="128" cy="150" r="22" fill={`url(#${g})`}/>
  </svg>;
}

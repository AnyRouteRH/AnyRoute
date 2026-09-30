"use client";
import { createContext, useContext, useEffect, useState } from "react";
import { hostsOpen } from "../../lib/network-hosts";
import { Button } from "../../components/UI";
import s from "./network.module.css";

export const NetworkHostsContext = createContext(false);

export default function NetworkAdmission({ children }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let active = true;
    hostsOpen().then((value) => { if (active) setOpen(value); });
    return () => { active = false; };
  }, []);
  return <NetworkHostsContext.Provider value={open}>{children}</NetworkHostsContext.Provider>;
}

// Both copies occupy the same grid cell, reserving their maximum dimensions.
// Inactive copy cannot be read or focused. Swapping adds no motion.
export function HostCopy({ closed, open }) {
  const admitted = useContext(NetworkHostsContext);
  return <span className={s.copy}>
    <span className={s.copyState} aria-hidden={admitted || undefined} inert={admitted || undefined} style={{ visibility: admitted ? "hidden" : "visible" }}>{closed}</span>
    <span className={s.copyState} aria-hidden={!admitted || undefined} inert={!admitted || undefined} style={{ visibility: admitted ? "visible" : "hidden" }}>{open}</span>
  </span>;
}

export function HostAction() {
  return <HostCopy closed={<Button href="#waitlist">Join the waitlist</Button>} open={<Button href="#join">Join as a host</Button>} />;
}

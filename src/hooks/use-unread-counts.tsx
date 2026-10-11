"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useTotalUnread } from "@/hooks/use-total-unread";
import { useUnreadNotifications } from "@/hooks/use-unread-notifications";

// The sidebar, the phone tab bar and the home-screen badge all show the same
// two counts. Computing them once here keeps it to one realtime channel each
// — two subscribers to the same channel name step on each other.

interface UnreadCounts {
  /** Conversations with at least one unread inbound message. */
  chats: number;
  /** Unread in-app notifications. */
  notifications: number;
}

const UnreadCountsContext = createContext<UnreadCounts>({ chats: 0, notifications: 0 });

export function UnreadCountsProvider({ children }: { children: ReactNode }) {
  const chats = useTotalUnread();
  const notifications = useUnreadNotifications();
  return (
    <UnreadCountsContext.Provider value={{ chats, notifications }}>
      {children}
    </UnreadCountsContext.Provider>
  );
}

export function useUnreadCounts(): UnreadCounts {
  return useContext(UnreadCountsContext);
}

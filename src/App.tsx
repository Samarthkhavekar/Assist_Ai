import React, { useState, useEffect, useCallback, Component, ErrorInfo, ReactNode } from 'react';
import { 
  Bell, 
  Calendar, 
  CheckCircle2, 
  Clock, 
  Plus, 
  Settings, 
  Trash2, 
  AlertCircle, 
  MessageSquare, 
  Smartphone, 
  Zap,
  ChevronRight,
  X,
  Send,
  Loader2
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { format, parseISO, isAfter, isBefore, addMinutes } from 'date-fns';
import { Toaster, toast } from 'sonner';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { parseReminderWithAI } from './services/aiService';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface User {
  id: number;
  phone_number: string;
}

interface Reminder {
  id: number;
  title: string;
  description: string;
  due_date: string;
  first_reminder_at: string;
  status: 'pending' | 'completed' | 'snoozed';
  urgency: 'low' | 'normal' | 'high' | 'critical';
  channels: string;
  repeat_interval_minutes: number;
  repeat_count: number;
  aggressive_mode: number;
  last_notified_at: string | null;
  next_notification_due_at: string | null;
  is_overdue: number;
}

interface UserSettings {
  phone_number: string;
  whatsapp_number: string;
  trusted_contact_phone: string;
  default_channels: string;
  aggressive_mode_enabled: number;
  accountability_mode_enabled: number;
}

interface Analytics {
  total: number;
  completed: number;
  completion_rate: number;
  urgency_distribution: { urgency: string, count: number }[];
  notifications_24h: number;
  failed_total: number;
}

interface ConfigStatus {
  twilio: {
    configured: boolean;
    sms_number: string | null;
    whatsapp_number: string | null;
    has_sid: boolean;
    has_token: boolean;
  };
  gemini: {
    configured: boolean;
  };
}

interface NotificationLog {
  id: number;
  reminder_id: number;
  reminder_title: string;
  channel: string;
  message_type: string;
  message: string;
  sent_at: string;
  delivery_status: 'sent' | 'failed';
  error_message: string | null;
}

// --- Error Boundary ---
class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[Assist Ai] Error Boundary caught an error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
          <div className="bg-white p-8 rounded-[2.5rem] shadow-2xl max-w-md w-full text-center">
            <div className="w-20 h-20 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-6">
              <AlertCircle className="w-10 h-10 text-red-500" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900 mb-2">Assist Ai is running</h1>
            <p className="text-gray-500 mb-8">Something went wrong on our end. We're working on it.</p>
            <button 
              onClick={() => window.location.reload()}
              className="w-full bg-emerald-500 text-white font-bold py-4 rounded-2xl shadow-lg shadow-emerald-200 hover:bg-emerald-600 transition-all"
            >
              Reload Application
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}

function AppContent() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [notifications, setNotifications] = useState<NotificationLog[]>([]);
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [configStatus, setConfigStatus] = useState<ConfigStatus | null>(null);
  const [notifiedIds, setNotifiedIds] = useState<Set<string>>(new Set());
  const [isAdding, setIsAdding] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isNotifCenterOpen, setIsNotifCenterOpen] = useState(false);
  const [naturalInput, setNaturalInput] = useState('');
  const [isParsing, setIsParsing] = useState(false);
  const [activeTab, setActiveTab] = useState<'upcoming' | 'completed' | 'productivity'>('upcoming');
  const [backendError, setBackendError] = useState(false);

  const fetchUser = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me');
      const data = await res.json();
      setUser(data.user);
    } catch (err) {
      console.error('Failed to fetch user', err);
    } finally {
      setIsAuthLoading(false);
    }
  }, []);

  const fetchReminders = useCallback(async () => {
    if (!user) return;
    try {
      const res = await fetch('/api/reminders');
      if (!res.ok) throw new Error('Backend error');
      const data = await res.json();
      setReminders(data);
      setBackendError(false);
    } catch (err) {
      console.error('Failed to fetch reminders', err);
      setBackendError(true);
    }
  }, [user]);

  const fetchNotifications = useCallback(async () => {
    if (!user) return;
    try {
      const res = await fetch('/api/notifications');
      const data = await res.json();
      setNotifications(data);
    } catch (err) {
      console.error('Failed to fetch notifications', err);
    }
  }, [user]);

  const fetchSettings = useCallback(async () => {
    if (!user) return;
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      setSettings(data);
    } catch (err) {
      console.error('Failed to fetch settings', err);
    }
  }, [user]);

  const fetchConfigStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/config-status');
      const data = await res.json();
      setConfigStatus(data);
    } catch (err) {
      console.error('Failed to fetch config status', err);
    }
  }, []);

  const fetchAnalytics = useCallback(async () => {
    if (!user) return;
    try {
      const res = await fetch('/api/analytics');
      const data = await res.json();
      setAnalytics(data);
    } catch (err) {
      console.error('Failed to fetch analytics', err);
    }
  }, [user]);

  const handleLogout = async () => {
    const logoutToast = toast.loading('Logging out...');
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      setUser(null);
      toast.success('Logged out successfully', { id: logoutToast });
    } catch (err) {
      toast.error('Logout failed', { id: logoutToast });
    }
  };

  useEffect(() => {
    fetchUser();
    fetchConfigStatus();
  }, [fetchUser, fetchConfigStatus]);

  useEffect(() => {
    if (user) {
      fetchReminders();
      fetchSettings();
      fetchNotifications();
      fetchAnalytics();

      if (Notification.permission === 'default') {
        Notification.requestPermission();
      }

      const pollInterval = setInterval(() => {
        fetchReminders();
        fetchNotifications();
      }, 10000);
      return () => clearInterval(pollInterval);
    }
  }, [user, fetchReminders, fetchSettings, fetchNotifications, fetchAnalytics]);

  // Client-side notification engine — fires toast + browser push every 10 seconds
  useEffect(() => {
    if (!user) return;

    const checkAndNotify = () => {
      const now = new Date();
      reminders.forEach(reminder => {
        if (reminder.status !== 'pending') return;

        const firstAlert = reminder.first_reminder_at
          ? parseISO(reminder.first_reminder_at)
          : parseISO(reminder.due_date);
        const nextDue = reminder.next_notification_due_at
          ? parseISO(reminder.next_notification_due_at)
          : firstAlert;

        // De-duplicate using compound key so repeating reminders re-fire after each gap
        const notifKey = `${reminder.id}::${reminder.next_notification_due_at ?? reminder.first_reminder_at}`;
        if (notifiedIds.has(notifKey)) return;

        const shouldFire =
          isBefore(nextDue, now) ||
          (!reminder.last_notified_at && isBefore(firstAlert, now));

        if (!shouldFire) return;

        const isPastDue = isBefore(parseISO(reminder.due_date), now);

        // IN-APP TOAST — always works, no permission needed
        if (isPastDue) {
          toast.error(`⚠️ OVERDUE: ${reminder.title}`, {
            description: `Was scheduled ${format(parseISO(reminder.due_date), 'h:mm a')}. Mark it complete!`,
            duration: 15000,
            action: {
              label: 'Complete',
              onClick: () => toggleStatus(reminder.id, reminder.status),
            },
          });
        } else {
          toast.warning(`🔔 ${reminder.title}`, {
            description: `Coming up at ${format(parseISO(reminder.due_date), 'h:mm a')}`,
            duration: 10000,
          });
        }

        // BROWSER PUSH — only if API available and granted
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          try {
            const title = isPastDue
              ? `⚠️ OVERDUE: ${reminder.title}`
              : `🔔 Remind: ${reminder.title}`;
            const body = isPastDue
              ? `Was scheduled ${format(parseISO(reminder.due_date), 'h:mm a')}. Mark it complete!`
              : `Coming up at ${format(parseISO(reminder.due_date), 'h:mm a')}`;
            new Notification(title, {
              body,
              tag: `assist-ai-${reminder.id}`,
              requireInteraction: reminder.urgency === 'critical',
            });
          } catch (_) {}
        }

        setNotifiedIds(prev => new Set([...prev, notifKey]));
      });
    };

    checkAndNotify();
    const pushInterval = setInterval(checkAndNotify, 10000);
    return () => clearInterval(pushInterval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reminders, user]);

  const handleParse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!naturalInput.trim()) return;

    const parseToast = toast.loading('AI is parsing your reminder...');
    setIsParsing(true);
    
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const referenceTime = new Date().toISOString();
      
      // Perform AI parsing on the client side with 10s timeout
      const parsePromise = parseReminderWithAI(naturalInput, referenceTime, timezone);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('AI parsing timed out after 10 seconds')), 10000)
      );

      const parsed = await Promise.race([parsePromise, timeoutPromise]) as any;
      
      if (process.env.NODE_ENV === 'development') {
        console.log('[AI Debug] Parsed Result:', parsed);
      }

      // Auto-save the parsed reminder
      const saveRes = await fetch('/api/reminders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...parsed,
          channels: Array.isArray(parsed.channels) ? parsed.channels.join(',') : 'push',
          aggressive_mode: settings?.aggressive_mode_enabled || 0
        }),
      });

      if (!saveRes.ok) {
        throw new Error('Failed to save reminder');
      }

      setNaturalInput('');
      fetchReminders();
      
      if (parsed.isFallback) {
        toast.warning(`Added (Fallback): ${parsed.title}`, { 
          id: parseToast,
          description: `AI was unavailable, used basic parsing.`
        });
      } else {
        toast.success(`Added: ${parsed.title}`, { 
          id: parseToast,
          description: `Due ${format(parseISO(parsed.due_date), 'PPp')}`
        });
      }
    } catch (err: any) {
      console.error('Failed to parse', err);
      toast.error(`AI parsing failed. Please enter manually.`, { 
        id: parseToast,
        description: err.message === 'AI parsing timed out after 10 seconds' ? 'Request timed out.' : 'Something went wrong.'
      });
    } finally {
      setIsParsing(false);
    }
  };

  const toggleStatus = async (id: number, currentStatus: string) => {
    const newStatus = currentStatus === 'completed' ? 'pending' : 'completed';
    const toggleToast = toast.loading(newStatus === 'completed' ? 'Marking as completed...' : 'Reopening task...');
    try {
      const res = await fetch(`/api/reminders/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error('Failed to update status');
      fetchReminders();
      toast.success(newStatus === 'completed' ? 'Task completed!' : 'Task reopened', { id: toggleToast });
    } catch (err) {
      toast.error('Failed to update status', { id: toggleToast });
    }
  };

  const deleteReminder = async (id: number) => {
    const deleteToast = toast.loading('Deleting signal...');
    try {
      const res = await fetch(`/api/reminders/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      fetchReminders();
      toast.success('Signal deleted', { id: deleteToast });
    } catch (err) {
      toast.error('Failed to delete signal', { id: deleteToast });
    }
  };

  const snoozeReminder = async (id: number) => {
    const snoozeToast = toast.loading('Snoozing for 15 minutes...');
    try {
      const res = await fetch(`/api/reminders/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snooze_minutes: 15 }),
      });
      if (!res.ok) throw new Error('Failed to snooze');
      fetchReminders();
      toast.success('Snoozed successfully', { id: snoozeToast });
    } catch (err) {
      toast.error('Failed to snooze', { id: snoozeToast });
    }
  };

  const upcomingReminders = reminders.filter(r => r.status !== 'completed');
  const completedReminders = reminders.filter(r => r.status === 'completed');

  if (isAuthLoading) {
    return (
      <div className="min-h-screen bg-[#0A0A0B] flex items-center justify-center">
        <Loader2 className="w-12 h-12 text-emerald-500 animate-spin" />
      </div>
    );
  }

  if (!user) {
    return <Login onLogin={setUser} />;
  }

  return (
    <div className="min-h-screen bg-[#0A0A0B] text-gray-100 font-sans selection:bg-emerald-500/30">
      <Toaster theme="dark" position="top-center" richColors />
      
      {backendError && (
        <div className="bg-red-600 text-white py-2 px-4 text-center text-xs font-bold animate-pulse shadow-lg shadow-red-900/20">
          SYSTEM OFFLINE: Backend connection lost.
        </div>
      )}
      <header className="sticky top-0 z-30 bg-[#0A0A0B]/80 backdrop-blur-xl border-b border-white/5">
        <div className="max-w-4xl mx-auto px-4 h-20 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-emerald-500 rounded-2xl flex items-center justify-center shadow-lg shadow-emerald-500/20 gaming-glow">
              <Zap className="text-black w-7 h-7 fill-black" />
            </div>
            <div>
              <h1 className="text-xl font-black tracking-tighter uppercase italic">Assist Ai</h1>
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
                <span className="text-[10px] font-bold text-emerald-500 uppercase tracking-widest">System Online</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button 
              onClick={() => setIsNotifCenterOpen(true)}
              className="p-3 hover:bg-white/5 rounded-2xl transition-all text-gray-400 relative border border-transparent hover:border-white/10"
            >
              <Bell className="w-6 h-6" />
              {notifications.length > 0 && (
                <span className="absolute top-2.5 right-2.5 w-3 h-3 bg-red-500 border-2 border-[#0A0A0B] rounded-full" />
              )}
            </button>
            <button 
              onClick={() => setIsSettingsOpen(true)}
              className="p-3 hover:bg-white/5 rounded-2xl transition-all text-gray-400 border border-transparent hover:border-white/10"
            >
              <Settings className="w-6 h-6" />
            </button>
            <button 
              onClick={handleLogout}
              className="p-3 hover:bg-white/5 rounded-2xl transition-all text-gray-400 border border-transparent hover:border-white/10"
              title="Logout"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>
      </header>

      {Notification.permission !== 'granted' && (
        <div className="bg-emerald-500/10 border-b border-emerald-500/20 py-3 px-4">
          <div className="max-w-4xl mx-auto flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-emerald-500/20 rounded-lg">
                <Bell className="w-4 h-4 text-emerald-500" />
              </div>
              <p className="text-xs text-emerald-100 font-medium">
                Neural link inactive. Enable notifications for real-time sync.
              </p>
            </div>
            <button 
              onClick={() => Notification.requestPermission().then(() => fetchReminders())}
              className="text-[10px] bg-emerald-500 text-black px-4 py-2 rounded-xl font-black uppercase tracking-widest hover:bg-emerald-400 transition-all"
            >
              Initialize
            </button>
          </div>
        </div>
      )}

      <main className="max-w-4xl mx-auto px-4 py-8">
        {/* Natural Language Input */}
        <section className="mb-12">
          <div className="bg-[#161618] rounded-[2rem] p-8 border border-white/5 shadow-2xl relative overflow-hidden">
            <div className="absolute top-0 left-0 w-1 h-full bg-emerald-500" />
            <h2 className="text-[10px] font-black text-emerald-500 uppercase tracking-[0.3em] mb-6 flex items-center gap-2">
              <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-ping" />
              Quick Command
            </h2>
            <form onSubmit={handleParse} className="relative">
              <input
                type="text"
                value={naturalInput}
                onChange={(e) => setNaturalInput(e.target.value)}
                placeholder={configStatus?.gemini.configured ? "Command: Remind me to call Mom tomorrow at 6 PM" : "AI OFFLINE: Missing Neural Key"}
                className="w-full bg-black/40 border border-white/5 rounded-2xl py-5 pl-8 pr-16 text-lg focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500/50 transition-all placeholder:text-gray-700 text-white font-medium"
                disabled={isParsing || !configStatus?.gemini.configured}
              />
              <button
                type="submit"
                disabled={isParsing || !naturalInput.trim() || !configStatus?.gemini.configured}
                className="absolute right-3 top-3 bottom-3 w-14 bg-emerald-500 text-black rounded-xl flex items-center justify-center hover:bg-emerald-400 disabled:bg-gray-800 disabled:text-gray-600 disabled:cursor-not-allowed transition-all shadow-lg shadow-emerald-500/20"
              >
                {isParsing ? <Loader2 className="w-6 h-6 animate-spin" /> : <Send className="w-6 h-6" />}
              </button>
            </form>
            <div className="mt-4 flex items-center gap-4 px-2">
              <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider">
                {configStatus?.gemini.configured 
                  ? "AI Engine: Active"
                  : "AI Engine: Offline"}
              </p>
              <div className="h-px flex-1 bg-white/5" />
              <p className="text-[10px] text-gray-600 italic">
                {configStatus?.gemini.configured 
                  ? "Natural language processing enabled"
                  : "Manual entry required"}
              </p>
            </div>
          </div>
        </section>

        {/* Tabs */}
        <div className="flex gap-8 mb-8 border-b border-white/5">
          <button
            onClick={() => setActiveTab('upcoming')}
            className={cn(
              "pb-4 text-xs font-black uppercase tracking-[0.2em] transition-all relative",
              activeTab === 'upcoming' ? "text-emerald-500" : "text-gray-600 hover:text-gray-400"
            )}
          >
            Upcoming
            {activeTab === 'upcoming' && (
              <motion.div layoutId="tab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('completed')}
            className={cn(
              "pb-4 text-xs font-black uppercase tracking-[0.2em] transition-all relative",
              activeTab === 'completed' ? "text-emerald-500" : "text-gray-600 hover:text-gray-400"
            )}
          >
            Archive
            {activeTab === 'completed' && (
              <motion.div layoutId="tab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]" />
            )}
          </button>
          <button
            onClick={() => {
              setActiveTab('productivity');
              fetchAnalytics();
            }}
            className={cn(
              "pb-4 text-xs font-black uppercase tracking-[0.2em] transition-all relative",
              activeTab === 'productivity' ? "text-emerald-500" : "text-gray-600 hover:text-gray-400"
            )}
          >
            Metrics
            {activeTab === 'productivity' && (
              <motion.div layoutId="tab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]" />
            )}
          </button>
        </div>

        {/* Reminders List or Analytics */}
        <div className="space-y-4">
          <AnimatePresence mode="wait">
            {activeTab === 'productivity' ? (
              <motion.div
                key="productivity"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="grid grid-cols-1 md:grid-cols-2 gap-6"
              >
                <div className="bg-[#161618] p-8 rounded-[2rem] border border-white/5 shadow-xl">
                  <h3 className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-6">Efficiency Rating</h3>
                  <div className="flex items-end gap-3">
                    <span className="text-5xl font-black text-emerald-500 tracking-tighter">{analytics?.completion_rate?.toFixed(0) || 0}%</span>
                    <span className="text-gray-500 text-xs font-bold mb-2 uppercase">{analytics?.completed || 0} / {analytics?.total || 0} Tasks</span>
                  </div>
                  <div className="mt-6 h-1.5 bg-white/5 rounded-full overflow-hidden">
                    <motion.div 
                      initial={{ width: 0 }}
                      animate={{ width: `${analytics?.completion_rate || 0}%` }}
                      className="h-full bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]"
                    />
                  </div>
                </div>
                <div className="bg-[#161618] p-8 rounded-[2rem] border border-white/5 shadow-xl">
                  <h3 className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-6">Neural Alerts (24h)</h3>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div className="w-14 h-14 bg-emerald-500/10 rounded-2xl flex items-center justify-center border border-emerald-500/20">
                        <Bell className="text-emerald-500 w-7 h-7" />
                      </div>
                      <div>
                        <span className="text-3xl font-black text-white">{analytics?.notifications_24h || 0}</span>
                        <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider">Signals Dispatched</p>
                      </div>
                    </div>
                    {analytics && analytics.failed_total > 0 && (
                      <div className="text-right">
                        <span className="text-2xl font-black text-red-500">{analytics.failed_total}</span>
                        <p className="text-[10px] text-red-500/50 font-black uppercase tracking-tighter">Errors</p>
                      </div>
                    )}
                  </div>
                </div>
                <div className="md:col-span-2 bg-[#161618] p-8 rounded-[2rem] border border-white/5 shadow-xl">
                  <h3 className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-6">Priority Spectrum</h3>
                  <div className="flex flex-wrap gap-3">
                    {analytics?.urgency_distribution?.map(item => (
                      <div key={item.urgency} className="flex items-center gap-3 bg-black/40 px-5 py-3 rounded-xl border border-white/5">
                        <span className="text-xs font-black uppercase tracking-wider text-gray-300">{item.urgency}</span>
                        <span className="bg-emerald-500/10 text-emerald-500 px-2.5 py-1 rounded-lg text-[10px] font-black border border-emerald-500/20">{item.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key={activeTab}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="space-y-6"
              >
                {(activeTab === 'upcoming' ? upcomingReminders : completedReminders).length === 0 ? (
                  <div className="text-center py-24 bg-[#161618] rounded-[2rem] border border-dashed border-white/5">
                    <div className="w-20 h-20 bg-white/5 rounded-full flex items-center justify-center mx-auto mb-6">
                      <Bell className="text-gray-700 w-10 h-10" />
                    </div>
                    <p className="text-gray-500 font-black uppercase tracking-widest text-xs">No active signals detected.</p>
                  </div>
                ) : (
                  (activeTab === 'upcoming' ? upcomingReminders : completedReminders).map((reminder) => (
                    <ReminderCard 
                      key={reminder.id} 
                      reminder={reminder} 
                      onToggle={() => toggleStatus(reminder.id, reminder.status)}
                      onDelete={() => deleteReminder(reminder.id)}
                      onSnooze={() => snoozeReminder(reminder.id)}
                    />
                  ))
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>

      {/* Settings Modal */}
      <AnimatePresence>
        {isSettingsOpen && (
          <SettingsModal 
            settings={settings} 
            configStatus={configStatus}
            onClose={() => setIsSettingsOpen(false)} 
            onSave={(newSettings) => {
              setSettings(newSettings);
              setIsSettingsOpen(false);
            }}
          />
        )}
      </AnimatePresence>

      {/* Notification Center Modal */}
      <AnimatePresence>
        {isNotifCenterOpen && (
          <NotificationCenter 
            notifications={notifications} 
            onClose={() => setIsNotifCenterOpen(false)} 
          />
        )}
      </AnimatePresence>

      {/* Floating Action Button for Manual Add */}
      <button 
        onClick={() => setIsAdding(true)}
        className="fixed bottom-8 right-8 w-16 h-16 bg-emerald-500 text-black rounded-2xl shadow-2xl shadow-emerald-500/20 flex items-center justify-center hover:scale-110 active:scale-95 transition-all z-40 gaming-glow"
      >
        <Plus className="w-10 h-10" />
      </button>

      {/* Manual Add Modal */}
      <AnimatePresence>
        {isAdding && (
          <AddReminderModal 
            onClose={() => setIsAdding(false)} 
            onAdd={() => {
              setIsAdding(false);
              fetchReminders();
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

const COUNTRY_CODES = [
  { code: '+91', name: 'India', flag: '🇮🇳' },
  { code: '+1', name: 'USA/Canada', flag: '🇺🇸' },
  { code: '+44', name: 'UK', flag: '🇬🇧' },
  { code: '+61', name: 'Australia', flag: '🇦🇺' },
  { code: '+81', name: 'Japan', flag: '🇯🇵' },
  { code: '+49', name: 'Germany', flag: '🇩🇪' },
  { code: '+33', name: 'France', flag: '🇫🇷' },
  { code: '+86', name: 'China', flag: '🇨🇳' },
  { code: '+7', name: 'Russia', flag: '🇷🇺' },
  { code: '+55', name: 'Brazil', flag: '🇧🇷' },
  { code: '+27', name: 'South Africa', flag: '🇿🇦' },
  { code: '+971', name: 'UAE', flag: '🇦🇪' },
  { code: '+65', name: 'Singapore', flag: '🇸🇬' },
];

function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [countryCode, setCountryCode] = useState('+91');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [isLoading, setIsLoading] = useState(false);
  const [devOtp, setDevOtp] = useState<string | null>(null);

  const fullPhoneNumber = `${countryCode}${phone.replace(/^\+/, '')}`;

  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    const sendToast = toast.loading('Sending verification code...');
    try {
      const res = await fetch('/api/auth/send-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone_number: fullPhoneNumber }),
      });
      const data = await res.json();
      
      if (data.otp) {
        // OTP returned in response (dev mode or Twilio not configured)
        setDevOtp(data.otp);
      }

      if (!data.success) {
        if (data.otp) {
          toast.success('Your verification code is ready below', { 
            id: sendToast,
            duration: 10000
          });
          setStep('otp');
          return;
        }
        throw new Error(data.error || data.message || 'Failed to send OTP');
      }

      setDevOtp(null);
      setStep('otp');
      toast.success('Code sent to your device', { id: sendToast });
    } catch (err: any) {
      toast.error(err.message || 'Failed to send code', { id: sendToast });
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    const verifyToast = toast.loading('Verifying code...');
    try {
      const res = await fetch('/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone_number: fullPhoneNumber, otp }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Verification failed');
      onLogin(data.user);
      toast.success('Welcome back!', { id: verifyToast });
    } catch (err: any) {
      toast.error(err.message, { id: verifyToast });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0A0A0B] flex items-center justify-center p-4">
      <Toaster theme="dark" position="top-center" richColors />
      <motion.div 
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-[#161618] w-full max-w-md rounded-[3rem] p-10 border border-white/5 shadow-2xl"
      >
        <div className="text-center mb-10">
          <div className="w-16 h-16 bg-emerald-500 rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-lg shadow-emerald-500/20 gaming-glow">
            <Zap className="text-black w-10 h-10 fill-black" />
          </div>
          <h1 className="text-3xl font-black tracking-tighter uppercase italic mb-2">Assist Ai</h1>
          <p className="text-[10px] font-bold text-emerald-500 uppercase tracking-widest">Neural Access Required</p>
        </div>

        <form onSubmit={step === 'phone' ? handleSendOtp : handleVerifyOtp} className="space-y-8">
          {step === 'phone' ? (
            <div>
              <label className="block text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-3">Phone Terminal</label>
              <div className="flex gap-2">
                <select
                  value={countryCode}
                  onChange={e => setCountryCode(e.target.value)}
                  className="bg-black/40 border border-white/5 rounded-2xl p-5 text-white font-medium outline-none transition-all appearance-none cursor-pointer hover:border-white/10"
                >
                  {COUNTRY_CODES.map(c => (
                    <option key={c.code} value={c.code} className="bg-[#161618] text-white">
                      {c.flag} {c.code}
                    </option>
                  ))}
                </select>
                <input
                  required
                  type="tel"
                  value={phone}
                  onChange={e => setPhone(e.target.value)}
                  placeholder="9876543210"
                  className="flex-1 bg-black/40 border border-white/5 rounded-2xl p-5 focus:ring-2 focus:ring-emerald-500/50 text-white font-medium outline-none transition-all"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <label className="block text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-3">Verification Code</label>
              
              {devOtp && (
                <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-2xl text-center">
                  <p className="text-[10px] font-black text-emerald-500 uppercase tracking-widest mb-2">Your Code</p>
                  <p className="text-3xl font-black text-emerald-400 tracking-[0.6em] font-mono">{devOtp}</p>
                  <p className="text-[9px] text-gray-500 mt-2">Enter this code below to continue</p>
                </div>
              )}

              <input
                required
                type="text"
                value={otp}
                onChange={e => setOtp(e.target.value)}
                placeholder="6-Digit Code"
                className="w-full bg-black/40 border border-white/5 rounded-2xl p-5 focus:ring-2 focus:ring-emerald-500/50 text-white font-medium outline-none transition-all text-center tracking-[0.5em] text-2xl"
              />
            </div>
          )}

          <button
            disabled={isLoading}
            type="submit"
            className="w-full bg-emerald-500 text-black font-black uppercase tracking-[0.2em] py-5 rounded-2xl shadow-xl shadow-emerald-500/20 hover:bg-emerald-400 transition-all active:scale-95 flex items-center justify-center gap-3"
          >
            {isLoading ? <Loader2 className="animate-spin" /> : step === 'phone' ? 'Request Access' : 'Initialize Session'}
          </button>

          {step === 'otp' && (
            <div className="flex gap-4">
              <button
                type="button"
                onClick={() => { setStep('phone'); setDevOtp(null); }}
                className="flex-1 text-[10px] text-gray-500 font-black uppercase tracking-widest hover:text-gray-400 transition-all"
              >
                Back to Terminal
              </button>
              <button
                type="button"
                onClick={handleSendOtp as any}
                disabled={isLoading}
                className="flex-1 text-[10px] text-emerald-500 font-black uppercase tracking-widest hover:text-emerald-400 transition-all"
              >
                Resend Code
              </button>
            </div>
          )}
        </form>
      </motion.div>
    </div>
  );
}

function ReminderCard({ reminder, onToggle, onDelete, onSnooze }: { reminder: Reminder, onToggle: () => void, onDelete: () => void, onSnooze: () => void }) {
  const isPastDue = isBefore(parseISO(reminder.due_date), new Date()) && reminder.status !== 'completed';
  
  const urgencyColors = {
    low: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    normal: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    high: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
    critical: 'bg-red-500/10 text-red-400 border-red-500/20 shadow-[0_0_10px_rgba(239,68,68,0.2)]'
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      className={cn(
        "group bg-[#161618] p-6 rounded-[2rem] border border-white/5 shadow-xl hover:border-white/10 transition-all flex items-start gap-5 relative overflow-hidden",
        reminder.status === 'completed' && "opacity-40 grayscale"
      )}
    >
      {isPastDue && (
        <div className="absolute top-0 left-0 w-1 h-full bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.5)]" />
      )}
      
      <button 
        onClick={onToggle}
        className={cn(
          "mt-1.5 w-7 h-7 rounded-xl border-2 flex items-center justify-center transition-all",
          reminder.status === 'completed' 
            ? "bg-emerald-500 border-emerald-500 text-black" 
            : "border-white/10 hover:border-emerald-500/50 bg-black/20"
        )}
      >
        {reminder.status === 'completed' && <CheckCircle2 className="w-5 h-5" />}
      </button>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-3 mb-2 flex-wrap">
          <h3 className={cn(
            "text-xl font-black tracking-tight",
            reminder.status === 'completed' && "line-through text-gray-600"
          )}>
            {reminder.title}
          </h3>
          <span className={cn("text-[10px] uppercase font-black tracking-widest px-3 py-1 rounded-lg border", urgencyColors[reminder.urgency])}>
            {reminder.urgency}
          </span>
          {reminder.aggressive_mode === 1 && (
            <span className="bg-red-500 text-black text-[10px] uppercase font-black tracking-widest px-3 py-1 rounded-lg flex items-center gap-1.5 shadow-lg shadow-red-900/20">
              <Zap className="w-3.5 h-3.5 fill-black" /> Aggressive
            </span>
          )}
        </div>
        
        {reminder.description && (
          <p className="text-gray-500 text-sm mb-4 line-clamp-2 font-medium leading-relaxed">{reminder.description}</p>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[10px] font-black uppercase tracking-widest text-gray-500">
          <div className={cn("flex items-center gap-2.5 p-2 bg-black/20 rounded-xl border border-white/5", isPastDue && "text-red-400 border-red-500/20 bg-red-500/5")}>
            <Calendar className="w-4 h-4" />
            <span>Event: {format(parseISO(reminder.due_date), 'MMM d, h:mm a')}</span>
          </div>
          <div className="flex items-center gap-2.5 p-2 bg-black/20 rounded-xl border border-white/5">
            <Bell className="w-4 h-4" />
            <span>Alert: {format(parseISO(reminder.first_reminder_at), 'MMM d, h:mm a')}</span>
          </div>
          {reminder.status === 'pending' && reminder.next_notification_due_at && (
            <div className="flex items-center gap-2.5 p-2 bg-emerald-500/5 text-emerald-500 rounded-xl border border-emerald-500/10">
              <Clock className="w-4 h-4" />
              <span>Next: {format(parseISO(reminder.next_notification_due_at), 'h:mm a')}</span>
            </div>
          )}
          <div className="flex items-center gap-2.5 p-2 bg-black/20 rounded-xl border border-white/5">
            <Smartphone className="w-4 h-4" />
            <span>{(reminder.channels?.split(',') || []).length} Channels</span>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2 opacity-0 group-hover:opacity-100 transition-all">
        {reminder.status !== 'completed' && (
          <button 
            onClick={onSnooze}
            className="p-3 bg-white/5 hover:bg-orange-500/10 text-gray-500 hover:text-orange-500 rounded-2xl transition-all border border-transparent hover:border-orange-500/20"
            title="Snooze 15m"
          >
            <Clock className="w-6 h-6" />
          </button>
        )}
        <button 
          onClick={onDelete}
          className="p-3 bg-white/5 hover:bg-red-500/10 text-gray-500 hover:text-red-500 rounded-2xl transition-all border border-transparent hover:border-red-500/20"
        >
          <Trash2 className="w-6 h-6" />
        </button>
      </div>
    </motion.div>
  );
}

function NotificationCenter({ notifications, onClose }: { notifications: NotificationLog[], onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-md">
      <motion.div 
        initial={{ opacity: 0, x: 100 }}
        animate={{ opacity: 1, x: 0 }}
        className="bg-[#161618] w-full max-w-md h-[85vh] rounded-[3rem] shadow-2xl overflow-hidden flex flex-col border border-white/5"
      >
        <div className="p-10 border-b border-white/5 flex items-center justify-between bg-black/20">
          <div>
            <h2 className="text-2xl font-black uppercase tracking-tighter">Signal Log</h2>
            <p className="text-[10px] font-bold text-emerald-500 uppercase tracking-widest mt-1">Neural History</p>
          </div>
          <button onClick={onClose} className="p-3 hover:bg-white/5 rounded-2xl transition-all border border-transparent hover:border-white/10"><X /></button>
        </div>
        
        <div className="flex-1 overflow-y-auto p-8 space-y-6">
          {notifications.length === 0 ? (
            <div className="text-center py-24">
              <div className="w-20 h-20 bg-white/5 rounded-full flex items-center justify-center mx-auto mb-6">
                <Bell className="w-10 h-10 text-gray-700" />
              </div>
              <p className="text-gray-500 font-black uppercase tracking-widest text-xs">No signals received.</p>
            </div>
          ) : (
            notifications.map((notif) => (
              <div key={notif.id} className={cn(
                "p-6 rounded-2xl border transition-all relative overflow-hidden",
                notif.delivery_status === 'failed' ? "bg-red-500/5 border-red-500/20" : "bg-black/40 border-white/5"
              )}>
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <span className={cn(
                      "text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-lg border",
                      notif.delivery_status === 'failed' ? "bg-red-500/10 text-red-500 border-red-500/20" : "bg-emerald-500/10 text-emerald-500 border-emerald-500/20"
                    )}>
                      {notif.channel}
                    </span>
                    <span className="text-[10px] font-black uppercase tracking-widest text-gray-500 bg-white/5 px-3 py-1 rounded-lg">
                      {notif.message_type}
                    </span>
                  </div>
                  <span className="text-[10px] font-bold text-gray-600">
                    {format(parseISO(notif.sent_at), 'h:mm a')}
                  </span>
                </div>
                <p className="text-sm font-black text-white mb-2 tracking-tight">{notif.reminder_title}</p>
                <p className="text-xs text-gray-500 leading-relaxed mb-4 font-medium">{notif.message}</p>
                {notif.delivery_status === 'failed' && notif.error_message && (
                  <div className="flex items-center gap-2 text-[10px] text-red-500 font-black bg-red-500/10 p-3 rounded-xl border border-red-500/20">
                    <AlertCircle className="w-4 h-4" />
                    {notif.error_message}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
        
        <div className="p-8 bg-black/40 border-t border-white/5">
          <div className="flex items-center gap-3 p-4 bg-emerald-500/5 rounded-2xl border border-emerald-500/10">
            <Zap className="text-emerald-500 w-5 h-5" />
            <p className="text-[10px] text-emerald-500/70 font-black uppercase tracking-widest leading-relaxed">
              Neural push protocols active. SMS/WhatsApp require Twilio configuration.
            </p>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function SettingsModal({ settings, configStatus, onClose, onSave }: { settings: UserSettings | null, configStatus: ConfigStatus | null, onClose: () => void, onSave: (s: UserSettings) => void }) {
  const [form, setForm] = useState<UserSettings>(settings || {
    phone_number: '',
    whatsapp_number: '',
    trusted_contact_phone: '',
    default_channels: 'push',
    aggressive_mode_enabled: 0,
    accountability_mode_enabled: 0
  });
  const [isSaving, setIsSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    const saveToast = toast.loading('Syncing configuration...');
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error('Failed to save settings');
      onSave(form);
      toast.success('Configuration synced', { id: saveToast });
    } catch (err) {
      toast.error('Failed to sync', { id: saveToast });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-md">
      <motion.div 
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-[#161618] w-full max-w-md rounded-[3rem] shadow-2xl overflow-hidden max-h-[90vh] overflow-y-auto border border-white/5"
      >
        <div className="p-10">
          <div className="flex items-center justify-between mb-10">
            <div>
              <h2 className="text-2xl font-black uppercase tracking-tighter">Preferences</h2>
              <p className="text-[10px] font-bold text-emerald-500 uppercase tracking-widest mt-1">System Configuration</p>
            </div>
            <button onClick={onClose} className="p-3 hover:bg-white/5 rounded-2xl transition-all border border-transparent hover:border-white/10"><X /></button>
          </div>

          <div className="mb-8 p-6 bg-black/40 rounded-2xl border border-white/5">
            <h3 className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-4">Neural Status</h3>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex flex-col">
                  <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">Twilio Link</span>
                  {configStatus?.twilio.sms_number && (
                    <span className="text-[9px] text-gray-600 font-mono mt-1">From: {configStatus.twilio.sms_number}</span>
                  )}
                </div>
                {configStatus?.twilio.configured ? (
                  <span className="text-[10px] font-black uppercase bg-emerald-500/10 text-emerald-500 px-3 py-1 rounded-lg border border-emerald-500/20">Active</span>
                ) : (
                  <span className="text-[10px] font-black uppercase bg-red-500/10 text-red-500 px-3 py-1 rounded-lg border border-red-500/20">Offline</span>
                )}
              </div>
              
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">Gemini Core</span>
                {configStatus?.gemini.configured ? (
                  <span className="text-[10px] font-black uppercase bg-emerald-500/10 text-emerald-500 px-3 py-1 rounded-lg border border-emerald-500/20">Active</span>
                ) : (
                  <span className="text-[10px] font-black uppercase bg-red-500/10 text-red-500 px-3 py-1 rounded-lg border border-red-500/20">Missing</span>
                )}
              </div>

              {!configStatus?.twilio.configured && (
                <div className="mt-4 p-4 bg-red-500/5 rounded-xl border border-red-500/10">
                  <p className="text-[9px] text-red-500/70 font-bold uppercase leading-relaxed tracking-widest">
                    To enable SMS/WhatsApp, update TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER in the Secrets panel.
                  </p>
                </div>
              )}
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-8">
            <div className="space-y-4">
              <div>
                <label className="block text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-3">Phone Terminal (SMS)</label>
                <div className="flex gap-2">
                  <select
                    value={COUNTRY_CODES.find(c => form.phone_number.startsWith(c.code))?.code || '+91'}
                    onChange={e => {
                      const newCode = e.target.value;
                      const oldCode = COUNTRY_CODES.find(c => form.phone_number.startsWith(c.code))?.code || '';
                      const numberWithoutCode = form.phone_number.startsWith(oldCode) ? form.phone_number.slice(oldCode.length) : form.phone_number;
                      setForm({...form, phone_number: `${newCode}${numberWithoutCode}`});
                    }}
                    className="bg-black/40 border border-white/5 rounded-2xl p-5 text-white font-medium outline-none transition-all appearance-none cursor-pointer hover:border-white/10"
                  >
                    {COUNTRY_CODES.map(c => (
                      <option key={c.code} value={c.code} className="bg-[#161618] text-white">
                        {c.flag} {c.code}
                      </option>
                    ))}
                  </select>
                  <input
                    type="tel"
                    value={COUNTRY_CODES.reduce((acc, c) => form.phone_number.startsWith(c.code) ? form.phone_number.slice(c.code.length) : acc, form.phone_number)}
                    onChange={e => {
                      const val = e.target.value;
                      const currentCode = COUNTRY_CODES.find(c => form.phone_number.startsWith(c.code))?.code || '+91';
                      setForm({...form, phone_number: `${currentCode}${val.replace(/^\+/, '')}`});
                    }}
                    placeholder="9876543210"
                    className="flex-1 bg-black/40 border border-white/5 rounded-2xl p-5 focus:ring-2 focus:ring-emerald-500/50 text-white font-medium outline-none transition-all"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-3">WhatsApp Node</label>
                <div className="flex gap-2">
                  <select
                    value={COUNTRY_CODES.find(c => form.whatsapp_number.startsWith(c.code))?.code || '+91'}
                    onChange={e => {
                      const newCode = e.target.value;
                      const oldCode = COUNTRY_CODES.find(c => form.whatsapp_number.startsWith(c.code))?.code || '';
                      const numberWithoutCode = form.whatsapp_number.startsWith(oldCode) ? form.whatsapp_number.slice(oldCode.length) : form.whatsapp_number;
                      setForm({...form, whatsapp_number: `${newCode}${numberWithoutCode}`});
                    }}
                    className="bg-black/40 border border-white/5 rounded-2xl p-5 text-white font-medium outline-none transition-all appearance-none cursor-pointer hover:border-white/10"
                  >
                    {COUNTRY_CODES.map(c => (
                      <option key={c.code} value={c.code} className="bg-[#161618] text-white">
                        {c.flag} {c.code}
                      </option>
                    ))}
                  </select>
                  <input
                    type="tel"
                    value={COUNTRY_CODES.reduce((acc, c) => form.whatsapp_number.startsWith(c.code) ? form.whatsapp_number.slice(c.code.length) : acc, form.whatsapp_number)}
                    onChange={e => {
                      const val = e.target.value;
                      const currentCode = COUNTRY_CODES.find(c => form.whatsapp_number.startsWith(c.code))?.code || '+91';
                      setForm({...form, whatsapp_number: `${currentCode}${val.replace(/^\+/, '')}`});
                    }}
                    placeholder="9876543210"
                    className="flex-1 bg-black/40 border border-white/5 rounded-2xl p-5 focus:ring-2 focus:ring-emerald-500/50 text-white font-medium outline-none transition-all"
                  />
                </div>
              </div>
            </div>

            <div className="p-6 bg-black/40 rounded-2xl border border-white/5">
              <div className="flex items-center justify-between mb-4">
                <p className="text-xs font-black uppercase tracking-widest text-gray-300">Browser Push</p>
                <span className={cn(
                  "text-[10px] font-black uppercase px-3 py-1 rounded-lg border",
                  Notification.permission === 'granted' ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" : "bg-red-500/10 text-red-500 border-red-500/20"
                )}>
                  {Notification.permission}
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (Notification.permission === 'default') {
                    Notification.requestPermission();
                  } else {
                    new Notification("Assist Ai Test", { body: "Neural link established." });
                  }
                }}
                className="text-[10px] text-emerald-500 font-black uppercase tracking-widest hover:text-emerald-400 transition-all flex items-center gap-2"
              >
                <Zap className="w-3 h-3" />
                {Notification.permission === 'default' ? "Request Access" : "Dispatch Test Signal"}
              </button>
            </div>

            <div className="flex items-center justify-between p-6 bg-emerald-500/5 rounded-2xl border border-emerald-500/10">
              <div className="flex items-center gap-4">
                <div className="p-3 bg-emerald-500/10 rounded-xl">
                  <Zap className="text-emerald-500 fill-emerald-500 w-6 h-6" />
                </div>
                <div>
                  <p className="font-black text-white uppercase tracking-tight">Aggressive Mode</p>
                  <p className="text-[10px] text-emerald-500/70 font-bold uppercase tracking-widest">5m Interval Pulse</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setForm({...form, aggressive_mode_enabled: form.aggressive_mode_enabled === 1 ? 0 : 1})}
                className={cn(
                  "w-14 h-7 rounded-full transition-all relative",
                  form.aggressive_mode_enabled === 1 ? "bg-emerald-500" : "bg-gray-800"
                )}
              >
                <div className={cn(
                  "absolute top-1 w-5 h-5 bg-white rounded-full transition-all shadow-lg",
                  form.aggressive_mode_enabled === 1 ? "left-8" : "left-1"
                )} />
              </button>
            </div>

            <div className="p-8 bg-red-500/5 rounded-[2rem] border border-red-500/10">
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-4">
                  <div className="p-3 bg-red-500/10 rounded-xl">
                    <AlertCircle className="text-red-500 w-6 h-6" />
                  </div>
                  <div>
                    <p className="font-black text-white uppercase tracking-tight">Accountability</p>
                    <p className="text-[10px] text-red-500/70 font-bold uppercase tracking-widest">External Escalation</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setForm({...form, accountability_mode_enabled: form.accountability_mode_enabled === 1 ? 0 : 1})}
                  className={cn(
                    "w-14 h-7 rounded-full transition-all relative",
                    form.accountability_mode_enabled === 1 ? "bg-red-500" : "bg-gray-800"
                  )}
                >
                  <div className={cn(
                    "absolute top-1 w-5 h-5 bg-white rounded-full transition-all shadow-lg",
                    form.accountability_mode_enabled === 1 ? "left-8" : "left-1"
                  )} />
                </button>
              </div>
              <p className="text-[10px] text-red-500/50 mb-6 leading-relaxed font-bold uppercase tracking-widest">
                Escalates critical signals to trusted contact after 30m delay.
              </p>
              <label className="block text-[10px] font-black text-red-500 uppercase tracking-[0.2em] mb-3">Trusted Contact Node</label>
              <input
                type="tel"
                value={form.trusted_contact_phone}
                onChange={e => setForm({...form, trusted_contact_phone: e.target.value})}
                placeholder="+1234567890"
                className="w-full bg-black/40 border border-red-500/10 rounded-2xl p-5 text-white font-medium outline-none focus:ring-2 focus:ring-red-500/30 transition-all"
              />
            </div>

            <button
              type="submit"
              disabled={isSaving}
              className="w-full bg-emerald-500 text-black font-black uppercase tracking-[0.2em] py-5 rounded-2xl shadow-xl shadow-emerald-500/20 hover:bg-emerald-400 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3"
            >
              {isSaving ? <Loader2 className="w-5 h-5 animate-spin" /> : null}
              {isSaving ? 'Syncing...' : 'Sync Configuration'}
            </button>
          </form>
        </div>
      </motion.div>
    </div>
  );
}

function AddReminderModal({ onClose, onAdd }: { onClose: () => void, onAdd: () => void }) {
  const [form, setForm] = useState({
    title: '',
    description: '',
    due_date: format(addMinutes(new Date(), 60), "yyyy-MM-dd'T'HH:mm"),
    first_reminder_at: format(addMinutes(new Date(), 45), "yyyy-MM-dd'T'HH:mm"),
    urgency: 'normal',
    channels: ['push'],
    repeat_interval_minutes: 0,
    repeat_count: 999,
    aggressive_mode: false
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    const addToast = toast.loading('Initializing signal...');
    try {
      const res = await fetch('/api/reminders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          channels: form.channels.join(',')
        }),
      });
      if (!res.ok) throw new Error('Failed to create reminder');
      toast.success('Signal initialized', { id: addToast });
      onAdd();
    } catch (err) {
      toast.error('Failed to initialize signal', { id: addToast });
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleChannel = (channel: string) => {
    setForm(prev => ({
      ...prev,
      channels: prev.channels.includes(channel) 
        ? prev.channels.filter(c => c !== channel)
        : [...prev.channels, channel]
    }));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-md">
      <motion.div 
        initial={{ opacity: 0, y: 50 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-[#161618] w-full max-w-2xl rounded-[3rem] shadow-2xl overflow-hidden max-h-[90vh] flex flex-col border border-white/5"
      >
        <div className="p-10 overflow-y-auto">
          <div className="flex items-center justify-between mb-10">
            <div>
              <h2 className="text-2xl font-black uppercase tracking-tighter">New Signal</h2>
              <p className="text-[10px] font-bold text-emerald-500 uppercase tracking-widest mt-1">Reminder Initialization</p>
            </div>
            <button onClick={onClose} className="p-3 hover:bg-white/5 rounded-2xl transition-all border border-transparent hover:border-white/10"><X /></button>
          </div>

          <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="md:col-span-2">
              <label className="block text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-3">Signal Title</label>
              <input
                required
                type="text"
                value={form.title}
                onChange={e => setForm({...form, title: e.target.value})}
                className="w-full bg-black/40 border border-white/5 rounded-2xl p-5 focus:ring-2 focus:ring-emerald-500/50 text-white font-medium outline-none transition-all"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-3">Description / Payload</label>
              <textarea
                value={form.description}
                onChange={e => setForm({...form, description: e.target.value})}
                className="w-full bg-black/40 border border-white/5 rounded-2xl p-5 focus:ring-2 focus:ring-emerald-500/50 text-white font-medium outline-none transition-all h-28"
              />
            </div>
            <div>
              <label className="block text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-3">Target Date & Time</label>
              <input
                required
                type="datetime-local"
                value={form.due_date}
                onChange={e => {
                  const newDueDate = e.target.value;
                  setForm({...form, due_date: newDueDate});
                }}
                className="w-full bg-black/40 border border-white/5 rounded-2xl p-5 focus:ring-2 focus:ring-emerald-500/50 text-white font-medium outline-none transition-all [color-scheme:dark]"
              />
            </div>
            <div>
              <label className="block text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-3">Initial Alert</label>
              <input
                required
                type="datetime-local"
                value={form.first_reminder_at}
                onChange={e => setForm({...form, first_reminder_at: e.target.value})}
                className="w-full bg-black/40 border border-white/5 rounded-2xl p-5 focus:ring-2 focus:ring-emerald-500/50 text-white font-medium outline-none transition-all [color-scheme:dark]"
              />
            </div>
            <div>
              <label className="block text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-3">Pulse Gap (mins)</label>
              <select
                value={form.repeat_interval_minutes}
                onChange={e => setForm({...form, repeat_interval_minutes: parseInt(e.target.value)})}
                className="w-full bg-black/40 border border-white/5 rounded-2xl p-5 focus:ring-2 focus:ring-emerald-500/50 text-white font-medium outline-none transition-all appearance-none"
              >
                <option value="0">No Pulse</option>
                <option value="5">5 Minutes</option>
                <option value="15">15 Minutes</option>
                <option value="30">30 Minutes</option>
                <option value="60">1 Hour</option>
                <option value="1440">1 Day</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-3">Priority Level</label>
              <select
                value={form.urgency}
                onChange={e => setForm({...form, urgency: e.target.value})}
                className="w-full bg-black/40 border border-white/5 rounded-2xl p-5 focus:ring-2 focus:ring-emerald-500/50 text-white font-medium outline-none transition-all appearance-none"
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>
            
            <div className="md:col-span-2">
              <label className="block text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-4">Transmission Channels</label>
              <div className="flex gap-4">
                {['push', 'sms', 'whatsapp'].map(channel => (
                  <button
                    key={channel}
                    type="button"
                    onClick={() => toggleChannel(channel)}
                    className={cn(
                      "flex-1 py-4 rounded-2xl border-2 font-black uppercase tracking-widest transition-all text-xs",
                      form.channels.includes(channel) 
                        ? "bg-emerald-500 border-emerald-500 text-black shadow-lg shadow-emerald-500/20" 
                        : "border-white/5 text-gray-600 hover:border-white/10 bg-black/20"
                    )}
                  >
                    {channel}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-4 p-6 bg-red-500/5 rounded-2xl border border-red-500/10">
              <Zap className="text-red-500 fill-red-500 w-6 h-6" />
              <div className="flex-1">
                <p className="font-black text-white uppercase tracking-tight">Aggressive Pulse</p>
                <p className="text-[10px] text-red-500/70 font-bold uppercase tracking-widest">5m Overdue Alerts</p>
              </div>
              <button
                type="button"
                onClick={() => setForm({...form, aggressive_mode: !form.aggressive_mode})}
                className={cn(
                  "w-14 h-7 rounded-full transition-all relative",
                  form.aggressive_mode ? "bg-red-500" : "bg-gray-800"
                )}
              >
                <div className={cn(
                  "absolute top-1 w-5 h-5 bg-white rounded-full transition-all shadow-lg",
                  form.aggressive_mode ? "left-8" : "left-1"
                )} />
              </button>
            </div>

            <div className="md:col-span-2 pt-4">
              <button
                type="submit"
                className="w-full bg-emerald-500 text-black font-black uppercase tracking-[0.2em] py-6 rounded-2xl shadow-2xl shadow-emerald-500/20 hover:bg-emerald-400 transition-all active:scale-95"
              >
                Initialize Signal
              </button>
            </div>
          </form>
        </div>
      </motion.div>
    </div>
  );
}

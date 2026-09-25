// The one icon library for the whole app (docs/DESIGN_SYSTEM.md: "one consistent icon library,
// don't mix styles"). Before this, every icon in Dineflow was a hand-picked Unicode glyph
// (⌂ ⌁ ▦ ♧ …) — consistent as a *mechanism* but not a real icon system: inconsistent visual
// weight, no shared stroke width, a card-suit symbol standing in for "Guests". Re-exported from
// one file so every icon actually in use in this app is visible in a single place, rather than
// each screen importing straight from lucide-react and slowly drifting into an unaudited mix.
export {
  LayoutDashboard, ShoppingCart, UtensilsCrossed, ClipboardList, Users, BarChart3,
  LayoutGrid, ChefHat, Package, Settings,
  Search, Plus, X, Check, ChevronDown, ChevronRight, ChevronLeft,
  AlertTriangle, CircleAlert, CircleCheck, Info,
  LogOut, CircleUser, Store, Wifi, WifiOff,
  Pencil, Trash2, Filter, ArrowUpDown, Clock, Calendar,
  TrendingUp, TrendingDown, Minus,
  Wallet, RefreshCw, Award, Receipt,
} from 'lucide-react'

# Sections

This file defines all sections, their ordering, impact levels, and descriptions.
The section ID (in parentheses) is the filename prefix used to group rules.

---

## 1. Eliminating Waterfalls (async)

**Impact:** CRITICAL  
**Description:** Waterfalls are the #1 performance killer. Each sequential await adds full latency.

## 2. Bundle Size Optimization (bundle)

**Impact:** CRITICAL  
**Description:** Reduce initial bundle size to improve interactive and load performance.

## 3. Server-Side Performance (server)

**Impact:** HIGH  
**Description:** Optimize server fetches, caching, and serialization to reduce response times.

## 4. Client-Side Data Fetching (client)

**Impact:** MEDIUM-HIGH  
**Description:** Deduplicate requests and subscriptions across components.

## 5. Re-render Optimization (rerender)

**Impact:** MEDIUM  
**Description:** Reduce unnecessary reactive updates and recomputation.

## 6. Rendering Performance (rendering)

**Impact:** MEDIUM  
**Description:** Reduce DOM and layout work during rendering.

## 7. JavaScript Performance (js)

**Impact:** LOW-MEDIUM  
**Description:** Micro-optimizations for hot paths that can add up.

## 8. Advanced Patterns (advanced)

**Impact:** LOW  
**Description:** Advanced patterns for specific edge cases.

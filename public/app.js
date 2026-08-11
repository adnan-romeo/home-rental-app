// app.js - HomeNest frontend logic
// Vanilla JS. Handles: theme toggle, auth forms, listing browsing/filtering,
// renter requests, landlord listing CRUD, request accept/reject, and the
// rent payment tracker. No frameworks, no build step.

(function () {
  'use strict';

  const PAGE = document.body.dataset.page;

  // ---------------------------------------------------------------------
  // API helper
  // ---------------------------------------------------------------------
  async function api(method, url, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin'
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    let data = {};
    try {
      data = await res.json();
    } catch (e) {
      data = {};
    }
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatMoney(n) {
    return '৳' + Number(n).toLocaleString('en-BD', { maximumFractionDigits: 0 });
  }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function showAlert(containerId, message, type) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = `<div class="alert alert-${type === 'error' ? 'error' : 'success'}">${escapeHtml(message)}</div>`;
    if (type !== 'error') {
      setTimeout(() => { if (el) el.innerHTML = ''; }, 3500);
    }
  }

  async function createCompressedDataUrl(file, maxDimension = 1200, quality = 0.8) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, maxDimension / Math.max(img.width, img.height));
          const width = Math.round(img.width * scale);
          const height = Math.round(img.height * scale);
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => reject(new Error('Failed to read image file.'));
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // Store photos for listing form
  let currentListingPhotos = [];

  async function handlePhotoSelection(files) {
    currentListingPhotos = [];
    const previewContainer = document.getElementById('photoPreview');
    if (!previewContainer) return;
    previewContainer.innerHTML = '';

    const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8 MB per file
    let skippedLargeFiles = false;

    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      if (file.size > MAX_FILE_SIZE) {
        skippedLargeFiles = true;
        continue;
      }
      try {
        const compressedDataUrl = await createCompressedDataUrl(file);
        currentListingPhotos.push(compressedDataUrl);

        const img = document.createElement('img');
        img.src = compressedDataUrl;
        img.className = 'photo-thumb';
        img.style.width = '80px';
        img.style.height = '80px';
        img.style.borderRadius = '6px';
        img.style.objectFit = 'cover';
        img.style.cursor = 'pointer';
        img.title = 'Click to remove';
        img.addEventListener('click', () => {
          currentListingPhotos = currentListingPhotos.filter((p) => p !== compressedDataUrl);
          img.remove();
        });
        previewContainer.appendChild(img);
      } catch (err) {
        console.error('Image processing failed:', err);
      }
    }

    if (skippedLargeFiles) {
      showAlert('landlordAlert', 'One or more photos were too large and were skipped. Use smaller images or fewer files.', 'error');
    }
  }

  // ---------------------------------------------------------------------
  // Theme toggle (shared across pages)
  // ---------------------------------------------------------------------
  function initTheme() {
    const root = document.documentElement;
    const saved = localStorage.getItem('homenest-theme') || 'light';
    root.setAttribute('data-theme', saved);
    updateThemeButton(saved);

    const btn = document.getElementById('themeToggle');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const current = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', current);
      localStorage.setItem('homenest-theme', current);
      updateThemeButton(current);
    });
  }

  function updateThemeButton(theme) {
    const label = document.getElementById('themeLabel');
    if (!label) return;
    label.textContent = theme === 'dark' ? 'Light' : 'Dark';
  }

  // ---------------------------------------------------------------------
  // AUTH PAGE (index.html)
  // ---------------------------------------------------------------------
  function initAuthPage() {
    // If already logged in, go straight to the dashboard.
    api('GET', '/api/auth/me')
      .then(() => { window.location.href = '/dashboard.html'; })
      .catch(() => { /* not logged in, stay here */ });

    const tabLogin = document.getElementById('tabLogin');
    const tabRegister = document.getElementById('tabRegister');
    const loginForm = document.getElementById('loginForm');
    const registerForm = document.getElementById('registerForm');

    tabLogin.addEventListener('click', () => {
      tabLogin.classList.add('active');
      tabRegister.classList.remove('active');
      loginForm.classList.remove('hidden');
      registerForm.classList.add('hidden');
      document.getElementById('authAlert').innerHTML = '';
    });

    tabRegister.addEventListener('click', () => {
      tabRegister.classList.add('active');
      tabLogin.classList.remove('active');
      registerForm.classList.remove('hidden');
      loginForm.classList.add('hidden');
      document.getElementById('authAlert').innerHTML = '';
    });

    let selectedRole = 'renter';
    document.querySelectorAll('.role-option').forEach((el) => {
      el.addEventListener('click', () => {
        document.querySelectorAll('.role-option').forEach((o) => o.classList.remove('selected'));
        el.classList.add('selected');
        selectedRole = el.dataset.role;
      });
    });

    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('loginEmail').value.trim();
      const password = document.getElementById('loginPassword').value;
      try {
        await api('POST', '/api/auth/login', { email, password });
        window.location.href = '/dashboard.html';
      } catch (err) {
        showAlert('authAlert', err.message, 'error');
      }
    });

    registerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        name: document.getElementById('regName').value.trim(),
        email: document.getElementById('regEmail').value.trim(),
        phone: document.getElementById('regPhone').value.trim(),
        password: document.getElementById('regPassword').value,
        role: selectedRole
      };
      try {
        await api('POST', '/api/auth/register', payload);
        window.location.href = '/dashboard.html';
      } catch (err) {
        showAlert('authAlert', err.message, 'error');
      }
    });
  }

  // ---------------------------------------------------------------------
  // DASHBOARD PAGE (dashboard.html)
  // ---------------------------------------------------------------------
  let CURRENT_USER = null;

  function initDashboardPage() {
    api('GET', '/api/auth/me')
      .then(({ user }) => {
        CURRENT_USER = user;
        document.getElementById('userChip').textContent = `${user.name} · ${user.role}`;
        if (user.role === 'renter') {
          document.getElementById('renterView').classList.remove('hidden');
          initRenterView();
        } else {
          document.getElementById('landlordView').classList.remove('hidden');
          initLandlordView();
        }
      })
      .catch(() => { window.location.href = '/index.html'; });

    document.getElementById('logoutBtn').addEventListener('click', async () => {
      try { await api('POST', '/api/auth/logout'); } catch (e) { /* ignore */ }
      window.location.href = '/index.html';
    });
  }

  function wireTabs(scopeSelector) {
    const scope = document.querySelector(scopeSelector);
    const tabButtons = scope.querySelectorAll('.tab-btn');
    tabButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        tabButtons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        scope.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
        const panel = document.getElementById('tab-' + btn.dataset.tab);
        if (panel) panel.classList.remove('hidden');
      });
    });
  }

  // ---------------- RENTER VIEW ----------------

  function initRenterView() {
    wireTabs('#renterView');

    document.getElementById('applyFilters').addEventListener('click', loadListings);
    document.getElementById('clearFilters').addEventListener('click', () => {
      document.getElementById('fLocation').value = '';
      document.getElementById('fMinRent').value = '';
      document.getElementById('fMaxRent').value = '';
      document.getElementById('fRooms').value = '';
      loadListings();
    });

    document.querySelectorAll('#renterView .tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.tab === 'myRequests') loadMyRequests();
        if (btn.dataset.tab === 'myRental') loadMyRental();
      });
    });

    loadListings();
  }

  async function loadListings() {
    const grid = document.getElementById('listingsGrid');
    grid.innerHTML = '<p class="empty-state">Loading listings…</p>';

    const params = new URLSearchParams();
    const location = document.getElementById('fLocation').value.trim();
    const minRent = document.getElementById('fMinRent').value;
    const maxRent = document.getElementById('fMaxRent').value;
    const rooms = document.getElementById('fRooms').value;
    if (location) params.set('location', location);
    if (minRent) params.set('minRent', minRent);
    if (maxRent) params.set('maxRent', maxRent);
    if (rooms) params.set('rooms', rooms);

    try {
      const { listings } = await api('GET', '/api/listings?' + params.toString());
      if (!listings.length) {
        grid.innerHTML = '<p class="empty-state">No available listings match your search.</p>';
        return;
      }
      grid.innerHTML = listings.map(listingCardHtml).join('');
      grid.querySelectorAll('[data-view-listing]').forEach((el) => {
        el.addEventListener('click', () => openListingDetail(el.dataset.viewListing));
      });
    } catch (err) {
      grid.innerHTML = `<p class="empty-state">${escapeHtml(err.message)}</p>`;
    }
  }

  function listingCardHtml(l) {
    const typeLabel = l.listing_type === 'roommate' ? 'Roommate finder' : 'Rental listing';
    const actionLabel = l.listing_type === 'roommate' ? 'Request to Join' : 'Request to Rent';
    const photoHtml = l.photos && l.photos.length > 0
      ? `<div class="listing-photo" style="background-image: url('${l.photos[0]}'); width: 100%; height: 180px; border-radius: 8px 8px 0 0; background-size: cover; background-position: center; margin-bottom: 12px;"></div>`
      : '';
    return `
      <div class="listing-card">
        ${photoHtml}
        <h3>${escapeHtml(l.title)}</h3>
        <div class="listing-badges">
          <span class="badge badge-type">${escapeHtml(typeLabel)}</span>
          ${l.is_sublet ? '<span class="badge badge-sublet">Sublet</span>' : ''}
        </div>
        <div class="meta">Location: ${escapeHtml(l.location)} &middot; ${l.rooms} room(s)</div>
        <div class="price">${formatMoney(l.rent_fee)}<span style="font-size:0.75rem;font-weight:500;color:var(--text-muted);">/mo</span></div>
        <div class="desc">${escapeHtml(l.description || 'No description provided.')}</div>
        <button class="btn btn-sm" data-view-listing="${l.id}">View Details</button>
      </div>`;
  }

  async function openListingDetail(id) {
    try {
      const { listing } = await api('GET', '/api/listings/' + id);
      const backdrop = document.createElement('div');
      backdrop.className = 'detail-modal-backdrop';
      const typeLabel = listing.listing_type === 'roommate' ? 'Roommate finder' : 'Rental listing';
      const actionLabel = listing.listing_type === 'roommate' ? 'Request to Join' : 'Request to Rent';
      const photosHtml = listing.photos && listing.photos.length > 0
        ? `<div class="detail-photos" style="margin-bottom: 16px;">
             ${listing.photos.map((photo) => `<img src="${photo}" style="width: 100%; max-height: 300px; object-fit: cover; border-radius: 8px; margin-bottom: 8px;" />`).join('')}
           </div>`
        : '';
      backdrop.innerHTML = `
        <div class="detail-modal">
          <div class="close-row"><button class="btn btn-secondary btn-sm" id="closeModal">Close</button></div>
          ${photosHtml}
          <h2 style="margin-top:0;">${escapeHtml(listing.title)}</h2>
          <div class="listing-badges" style="margin-bottom:12px;">
            <span class="badge badge-type">${escapeHtml(typeLabel)}</span>
            ${listing.is_sublet ? '<span class="badge badge-sublet">Sublet</span>' : ''}
          </div>
          <p class="meta">Location: ${escapeHtml(listing.location)} &middot; ${listing.rooms} room(s)</p>
          <p class="price" style="font-size:1.4rem;">${formatMoney(listing.rent_fee)}/mo</p>
          <p>${escapeHtml(listing.description || 'No description provided.')}</p>
          <hr style="border-color:var(--border);" />
          <p><strong>Posted by:</strong> ${escapeHtml(listing.poster_name)}</p>
          <p><strong>Phone:</strong> ${escapeHtml(listing.poster_phone)}</p>
          <p><strong>Email:</strong> ${escapeHtml(listing.poster_email)}</p>
          <div id="modalAlert"></div>
          ${listing.status === 'available'
            ? `<button class="btn btn-block" id="requestBtn">${escapeHtml(actionLabel)}</button>`
            : `<p class="badge badge-rented">Currently Rented</p>`}
        </div>`;
      document.body.appendChild(backdrop);

      backdrop.querySelector('#closeModal').addEventListener('click', () => backdrop.remove());
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });

      const reqBtn = backdrop.querySelector('#requestBtn');
      if (reqBtn) {
        reqBtn.addEventListener('click', async () => {
          reqBtn.disabled = true;
          try {
            await api('POST', '/api/requests', { listingId: listing.id });
            backdrop.querySelector('#modalAlert').innerHTML =
              '<div class="alert alert-success">Request sent! Check "My Requests" for updates.</div>';
            reqBtn.remove();
          } catch (err) {
            backdrop.querySelector('#modalAlert').innerHTML =
              `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
            reqBtn.disabled = false;
          }
        });
      }
    } catch (err) {
      showAlert('renterAlert', err.message, 'error');
    }
  }

  async function loadMyRequests() {
    const el = document.getElementById('myRequestsList');
    el.innerHTML = '<p class="empty-state">Loading…</p>';
    try {
      const { requests } = await api('GET', '/api/requests/mine');
      if (!requests.length) {
        el.innerHTML = '<p class="empty-state">You haven\'t sent any rental requests yet.</p>';
        return;
      }
      el.innerHTML = requests.map((r) => `
        <div class="row-item">
          <div class="row-main">
            <h4>${escapeHtml(r.title)}</h4>
            <div class="meta">Location: ${escapeHtml(r.location)} &middot; ${formatMoney(r.rent_fee)}/mo &middot; requested ${formatDate(r.created_at)}</div>
          </div>
          <span class="badge badge-${r.status}">${r.status}</span>
        </div>
      `).join('');
    } catch (err) {
      el.innerHTML = `<p class="empty-state">${escapeHtml(err.message)}</p>`;
    }
  }

  async function loadMyRental() {
    const el = document.getElementById('myRentalInfo');
    el.innerHTML = '<p class="empty-state">Loading…</p>';
    try {
      const data = await api('GET', '/api/dashboard/renter');
      if (!data.activeRental) {
        el.innerHTML = '<p class="empty-state">You do not have an active rental yet. Once a landlord accepts one of your requests, it will show up here.</p>';
        return;
      }
      const r = data.activeRental;
      const p = data.payment;
      el.innerHTML = `
        <h3 style="margin-top:0;">${escapeHtml(r.title)}</h3>
        <p class="meta">Location: ${escapeHtml(r.location)} &middot; ${r.rooms} room(s) &middot; ${formatMoney(r.rent_fee)}/mo</p>
        <p><strong>Landlord:</strong> ${escapeHtml(r.landlord_name)} &middot; ${escapeHtml(r.landlord_phone)}</p>
        <p><strong>This month's rent (${escapeHtml(p.month)}):</strong>
          <span class="badge badge-${p.is_paid ? 'paid' : 'unpaid'}">${p.is_paid ? 'Paid' : 'Unpaid'}</span>
        </p>
        <p class="meta">Your landlord updates this status once payment is received.</p>
      `;
    } catch (err) {
      el.innerHTML = `<p class="empty-state">${escapeHtml(err.message)}</p>`;
    }
  }

  // ---------------- LANDLORD VIEW ----------------

  function initLandlordView() {
    wireTabs('#landlordView');

    document.querySelectorAll('#landlordView .tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.tab === 'incomingRequests') loadIncomingRequests();
        if (btn.dataset.tab === 'payments') loadPayments();
      });
    });

    document.getElementById('listingForm').addEventListener('submit', submitListingForm);
    document.getElementById('listingCancelEdit').addEventListener('click', resetListingForm);
    
    const photoInput = document.getElementById('lPhotos');
    if (photoInput) {
      photoInput.addEventListener('change', (e) => {
        handlePhotoSelection(e.target.files);
      });
    }

    loadLandlordDashboard();
    loadMyListings();
  }

  async function loadLandlordDashboard() {
    try {
      const { stats } = await api('GET', '/api/dashboard/landlord');
      document.getElementById('statsGrid').innerHTML = `
        <div class="stat-card"><div class="stat-value">${stats.totalListings}</div><div class="stat-label">Total Listings</div></div>
        <div class="stat-card"><div class="stat-value">${stats.rentedCount}</div><div class="stat-label">Rented Units</div></div>
        <div class="stat-card"><div class="stat-value">${stats.vacantCount}</div><div class="stat-label">Vacant Units</div></div>
        <div class="stat-card"><div class="stat-value">${stats.pendingRequestsCount}</div><div class="stat-label">Pending Requests</div></div>
      `;
      const badge = document.getElementById('pendingCountBadge');
      badge.textContent = stats.pendingRequestsCount > 0 ? `(${stats.pendingRequestsCount})` : '';
    } catch (err) {
      showAlert('landlordAlert', err.message, 'error');
    }
  }

  async function loadMyListings() {
    const el = document.getElementById('myListingsList');
    el.innerHTML = '<p class="empty-state">Loading…</p>';
    try {
      const { listings } = await api('GET', '/api/listings?mine=1');
      if (!listings.length) {
        el.innerHTML = '<p class="empty-state">You haven\'t created any listings yet. Use the form above to add one.</p>';
        return;
      }
      el.innerHTML = listings.map((l) => `
        <div class="row-item">
          <div class="row-main">
            <h4>${escapeHtml(l.title)}</h4>
            <div class="listing-badges" style="margin: 0 0 6px;">
              <span class="badge badge-type">${escapeHtml(l.listing_type === 'roommate' ? 'Roommate finder' : 'Rental listing')}</span>
              ${l.is_sublet ? '<span class="badge badge-sublet">Sublet</span>' : ''}
            </div>
            <div class="meta">Location: ${escapeHtml(l.location)} &middot; ${l.rooms} room(s) &middot; ${formatMoney(l.rent_fee)}/mo</div>
          </div>
          <span class="badge badge-${l.status}">${l.status}</span>
          <div class="btn-row">
            <button class="btn btn-secondary btn-sm" data-edit="${l.id}">Edit</button>
            <button class="btn btn-danger btn-sm" data-delete="${l.id}">Delete</button>
          </div>
        </div>
      `).join('');

      el.querySelectorAll('[data-edit]').forEach((btn) => {
        btn.addEventListener('click', () => startEditListing(btn.dataset.edit, listings));
      });
      el.querySelectorAll('[data-delete]').forEach((btn) => {
        btn.addEventListener('click', () => deleteListing(btn.dataset.delete));
      });
    } catch (err) {
      el.innerHTML = `<p class="empty-state">${escapeHtml(err.message)}</p>`;
    }
  }

  function startEditListing(id, listings) {
    const listing = listings.find((l) => String(l.id) === String(id));
    if (!listing) return;
    document.getElementById('listingId').value = listing.id;
    document.getElementById('lTitle').value = listing.title;
    document.getElementById('lDescription').value = listing.description || '';
    document.getElementById('lRentFee').value = listing.rent_fee;
    document.getElementById('lRooms').value = listing.rooms;
    document.getElementById('lLocation').value = listing.location;
    document.getElementById('lListingType').value = listing.listing_type || 'rental';
    document.getElementById('lIsSublet').checked = Boolean(listing.is_sublet);
    
    // Load existing photos
    currentListingPhotos = listing.photos || [];
    const previewContainer = document.getElementById('photoPreview');
    if (previewContainer) {
      previewContainer.innerHTML = '';
      currentListingPhotos.forEach((photoData) => {
        const img = document.createElement('img');
        img.src = photoData;
        img.className = 'photo-thumb';
        img.style.width = '80px';
        img.style.height = '80px';
        img.style.borderRadius = '6px';
        img.style.objectFit = 'cover';
        img.style.cursor = 'pointer';
        img.title = 'Click to remove';
        img.addEventListener('click', () => {
          currentListingPhotos = currentListingPhotos.filter((p) => p !== photoData);
          img.remove();
        });
        previewContainer.appendChild(img);
      });
    }
    
    document.getElementById('listingFormTitle').textContent = 'Edit Listing';
    document.getElementById('listingSubmitBtn').textContent = 'Save Changes';
    document.getElementById('listingCancelEdit').classList.remove('hidden');
    document.getElementById('listingForm').scrollIntoView({ behavior: 'smooth' });
  }

  function resetListingForm() {
    document.getElementById('listingForm').reset();
    document.getElementById('listingId').value = '';
    document.getElementById('lListingType').value = 'rental';
    document.getElementById('lIsSublet').checked = false;
    currentListingPhotos = [];
    const previewContainer = document.getElementById('photoPreview');
    if (previewContainer) previewContainer.innerHTML = '';
    document.getElementById('listingFormTitle').textContent = 'Create a New Listing';
    document.getElementById('listingSubmitBtn').textContent = 'Create Listing';
    document.getElementById('listingCancelEdit').classList.add('hidden');
  }

  async function submitListingForm(e) {
    e.preventDefault();
    const id = document.getElementById('listingId').value;
    const payload = {
      title: document.getElementById('lTitle').value.trim(),
      description: document.getElementById('lDescription').value.trim(),
      rent_fee: Number(document.getElementById('lRentFee').value),
      rooms: Number(document.getElementById('lRooms').value),
      location: document.getElementById('lLocation').value.trim(),
      listing_type: document.getElementById('lListingType').value,
      is_sublet: document.getElementById('lIsSublet').checked,
      photos: currentListingPhotos
    };
    try {
      if (id) {
        await api('PUT', '/api/listings/' + id, payload);
        showAlert('landlordAlert', 'Listing updated.', 'success');
      } else {
        await api('POST', '/api/listings', payload);
        showAlert('landlordAlert', 'Listing created.', 'success');
      }
      resetListingForm();
      loadMyListings();
      loadLandlordDashboard();
    } catch (err) {
      showAlert('landlordAlert', err.message, 'error');
    }
  }

  async function deleteListing(id) {
    if (!confirm('Delete this listing? This cannot be undone.')) return;
    try {
      await api('DELETE', '/api/listings/' + id);
      loadMyListings();
      loadLandlordDashboard();
    } catch (err) {
      showAlert('landlordAlert', err.message, 'error');
    }
  }

  async function loadIncomingRequests() {
    const el = document.getElementById('incomingRequestsList');
    el.innerHTML = '<p class="empty-state">Loading…</p>';
    try {
      const { requests } = await api('GET', '/api/requests/incoming');
      if (!requests.length) {
        el.innerHTML = '<p class="empty-state">No rental requests yet.</p>';
        return;
      }
      el.innerHTML = requests.map((r) => `
        <div class="row-item">
          <div class="row-main">
            <h4>${escapeHtml(r.listing_title)}</h4>
            <div class="meta">From ${escapeHtml(r.renter_name)} (${escapeHtml(r.renter_phone)}) &middot; requested ${formatDate(r.created_at)}</div>
          </div>
          ${r.status === 'pending'
            ? `<div class="btn-row">
                 <button class="btn btn-success btn-sm" data-accept="${r.id}">Accept</button>
                 <button class="btn btn-danger btn-sm" data-reject="${r.id}">Reject</button>
               </div>`
            : `<span class="badge badge-${r.status}">${r.status}</span>`}
        </div>
      `).join('');

      el.querySelectorAll('[data-accept]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await api('PUT', `/api/requests/${btn.dataset.accept}/accept`);
            loadIncomingRequests();
            loadLandlordDashboard();
            loadMyListings();
          } catch (err) {
            showAlert('landlordAlert', err.message, 'error');
            btn.disabled = false;
          }
        });
      });
      el.querySelectorAll('[data-reject]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await api('PUT', `/api/requests/${btn.dataset.reject}/reject`);
            loadIncomingRequests();
            loadLandlordDashboard();
          } catch (err) {
            showAlert('landlordAlert', err.message, 'error');
            btn.disabled = false;
          }
        });
      });
    } catch (err) {
      el.innerHTML = `<p class="empty-state">${escapeHtml(err.message)}</p>`;
    }
  }

  async function loadPayments() {
    const el = document.getElementById('paymentsList');
    el.innerHTML = '<p class="empty-state">Loading…</p>';
    try {
      const { rentedUnits } = await api('GET', '/api/dashboard/landlord');
      if (!rentedUnits.length) {
        el.innerHTML = '<p class="empty-state">No rented units to track payments for yet.</p>';
        return;
      }
      el.innerHTML = rentedUnits.map((u) => `
        <div class="row-item">
          <div class="row-main">
            <h4>${escapeHtml(u.listing.title)}</h4>
            <div class="meta">Renter: ${u.renter ? escapeHtml(u.renter.name) + ' (' + escapeHtml(u.renter.phone) + ')' : 'Unknown'} &middot; ${formatMoney(u.payment.amount)}/mo &middot; ${escapeHtml(u.payment.month)}</div>
          </div>
          <div class="toggle-switch" data-toggle-listing="${u.listing.id}">
            <span class="switch-track ${u.payment.is_paid ? 'on' : ''}"><span class="switch-thumb"></span></span>
            <span>${u.payment.is_paid ? 'Paid' : 'Unpaid'}</span>
          </div>
        </div>
      `).join('');

      el.querySelectorAll('[data-toggle-listing]').forEach((row) => {
        row.addEventListener('click', async () => {
          try {
            await api('POST', '/api/payments/toggle', { listingId: row.dataset.toggleListing });
            loadPayments();
          } catch (err) {
            showAlert('landlordAlert', err.message, 'error');
          }
        });
      });
    } catch (err) {
      el.innerHTML = `<p class="empty-state">${escapeHtml(err.message)}</p>`;
    }
  }

  // ---------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    if (PAGE === 'auth') initAuthPage();
    if (PAGE === 'dashboard') initDashboardPage();
  });
})();

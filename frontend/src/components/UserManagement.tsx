import { useState, useEffect } from 'react';
import { Users as UsersIcon, Plus, Edit2, Trash2, X } from 'lucide-react';
import { users, accounts, type UserInfo } from '../api';

export function UserManagement() {
  const [userList, setUserList] = useState<UserInfo[]>([]);
  const [allContainers, setAllContainers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Modal state
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [selectedUser, setSelectedUser] = useState<UserInfo | null>(null);

  // Form state
  const [formData, setFormData] = useState({
    username: '',
    password: '',
    confirmPassword: '',
    is_admin: false,
    can_add_containers: false,
    can_edit_server_accent: false,
  });

  const [selectedContainerIds, setSelectedContainerIds] = useState<number[]>([]);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const [usersData, containersData] = await Promise.all([
        users.list(),
        accounts.list(),
      ]);
      setUserList(usersData.users);
      setAllContainers(containersData.accounts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (formData.password !== formData.confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (formData.password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    try {
      const res = await users.create(
        formData.username,
        formData.password,
        formData.is_admin,
        formData.can_add_containers,
        formData.can_edit_server_accent,
      );
      if (!formData.is_admin && selectedContainerIds.length > 0) {
        await users.setContainers(res.user_id, selectedContainerIds);
      }
      setSuccess('User created successfully');
      setShowAddModal(false);
      setFormData({
        username: '',
        password: '',
        confirmPassword: '',
        is_admin: false,
        can_add_containers: false,
        can_edit_server_accent: false,
      });
      setSelectedContainerIds([]);
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create user');
    }
  };

  const handleUpdateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUser) return;

    setError('');
    setSuccess('');

    // Validate password if provided
    if (formData.password) {
      if (formData.password !== formData.confirmPassword) {
        setError('Passwords do not match');
        return;
      }
      if (formData.password.length < 6) {
        setError('Password must be at least 6 characters');
        return;
      }
    }

    try {
      // Update user (username, password, permissions)
      await users.update(
        selectedUser.id,
        formData.username !== selectedUser.username ? formData.username : undefined,
        formData.password || undefined,
        formData.is_admin,
        formData.can_add_containers,
        formData.can_edit_server_accent,
      );

      // Update container permissions
      await users.setContainers(selectedUser.id, selectedContainerIds);

      setSuccess('User updated successfully');
      setShowEditModal(false);
      setSelectedUser(null);
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update user');
    }
  };

  const handleDeleteUser = async () => {
    if (!selectedUser) return;

    setError('');
    setSuccess('');

    try {
      await users.delete(selectedUser.id);
      setSuccess('User deleted successfully');
      setShowDeleteModal(false);
      setSelectedUser(null);
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete user');
    }
  };

  const handleOpenEdit = async (user: UserInfo) => {
    setSelectedUser(user);
    setFormData({
      username: user.username,
      password: '',
      confirmPassword: '',
      is_admin: user.is_admin,
      can_add_containers: user.can_add_containers,
      can_edit_server_accent: user.can_edit_server_accent,
    });

    // Load container permissions
    try {
      const containerPerms = await users.getContainers(user.id);
      setSelectedContainerIds(containerPerms.container_ids);
    } catch (err) {
      console.error('Failed to load container permissions:', err);
      setSelectedContainerIds([]);
    }

    setShowEditModal(true);
  };

  const handleOpenDelete = (user: UserInfo) => {
    setSelectedUser(user);
    setShowDeleteModal(true);
  };

  const toggleContainer = (containerId: number) => {
    setSelectedContainerIds(prev =>
      prev.includes(containerId)
        ? prev.filter(id => id !== containerId)
        : [...prev, containerId]
    );
  };

  const getPermissionCount = (user: UserInfo) => {
    let count = 0;
    if (user.is_admin) count++;
    if (user.can_add_containers) count++;
    if (user.can_edit_server_accent) count++;
    return count;
  };

  const getPermissionText = (user: UserInfo) => {
    const perms = [];
    if (user.is_admin) perms.push('Admin');
    if (user.can_add_containers) perms.push('Can add containers');
    if (user.can_edit_server_accent) perms.push('Can edit server accent');
    return perms.join(', ');
  };

  if (loading) {
    return (
      <div className="card">
        {/* Header skeleton */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <div className="skeleton h-5 w-5 rounded"></div>
            <div className="skeleton h-6 w-32"></div>
          </div>
          <div className="skeleton h-9 w-24 rounded"></div>
        </div>

        {/* User list skeleton */}
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="p-4 rounded-lg bg-(--bg-tertiary)">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="skeleton h-5 w-32 mb-2"></div>
                  <div className="skeleton h-3 w-40"></div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="skeleton h-8 w-8 rounded"></div>
                  <div className="skeleton h-8 w-8 rounded"></div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <UsersIcon className="w-5 h-5 text-(--accent)" />
          <h2 className="text-xl font-semibold">User Management</h2>
        </div>
        <button
          onClick={() => {
            setFormData({
              username: '',
              password: '',
              confirmPassword: '',
              is_admin: false,
              can_add_containers: false,
            });
            setSelectedContainerIds([]);
            setShowAddModal(true);
          }}
          className="btn btn-primary flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          Add User
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded text-red-400 text-sm">
          {error}
        </div>
      )}

      {success && (
        <div className="mb-4 p-3 bg-green-500/10 border border-green-500/30 rounded text-green-400 text-sm">
          {success}
        </div>
      )}

      <div className="space-y-2">
        {userList.map((user) => {
          const permCount = getPermissionCount(user);
          const permText = getPermissionText(user);

          return (
            <div
              key={user.id}
              className="flex items-center justify-between p-4 rounded-lg bg-(--bg-primary) transition-colors"
            >
              <div className="flex-1">
                <div className="flex items-center gap-3">
                  <span className="font-semibold">{user.username}</span>
                  {permCount > 0 && (
                    <span
                      className="text-sm text-(--accent) cursor-help"
                      title={permText}
                    >
                      ({permCount} permission{permCount > 1 ? 's' : ''})
                    </span>
                  )}
                </div>
                <p className="text-xs text-(--text-secondary) mt-1">
                  Created: {new Date(user.created_at).toLocaleDateString()}
                </p>
              </div>

              {user.id !== 1 && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleOpenEdit(user)}
                    className="icon-btn"
                    title="Edit user"
                  >
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleOpenDelete(user)}
                    className="icon-btn icon-btn-danger"
                    title="Delete user"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Add User Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-(--bg-secondary) rounded-lg shadow-xl max-w-md w-full border border-(--bg-tertiary) p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-bold">Add User</h3>
              <button onClick={() => setShowAddModal(false)} className="icon-btn">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleAddUser} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Username</label>
                <input
                  type="text"
                  value={formData.username}
                  onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                  className="input w-full"
                  required
                  minLength={3}
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Password</label>
                <input
                  type="password"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  className="input w-full"
                  required
                  minLength={6}
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Confirm Password</label>
                <input
                  type="password"
                  value={formData.confirmPassword}
                  onChange={(e) => setFormData({ ...formData, confirmPassword: e.target.value })}
                  className="input w-full"
                  required
                />
              </div>

              <div className="space-y-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.is_admin}
                    onChange={(e) => setFormData({ ...formData, is_admin: e.target.checked })}
                  />
                  <span className="text-sm">Admin privileges (access to all containers and user management)</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.can_add_containers}
                    onChange={(e) => setFormData({ ...formData, can_add_containers: e.target.checked })}
                  />
                  <span className="text-sm">Can add containers</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.can_edit_server_accent}
                    onChange={(e) => setFormData({ ...formData, can_edit_server_accent: e.target.checked })}
                  />
                  <span className="text-sm">Can edit server accent color</span>
                </label>
              </div>

              {/* Container Access */}
              <div>
                <label className="block text-sm font-medium mb-2">Container Access</label>
                {formData.is_admin ? (
                  <p className="text-(--text-secondary) text-sm">
                    Admin users have access to all containers automatically.
                  </p>
                ) : (
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {allContainers.map((container) => (
                      <label
                        key={container.id}
                        className="flex items-center gap-3 p-3 rounded bg-(--bg-primary) cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={selectedContainerIds.includes(container.id)}
                          onChange={() => toggleContainer(container.id)}
                        />
                        <div className="flex-1">
                          <div className="font-medium text-sm">{container.container_name}</div>
                          <div className="text-xs text-(--text-secondary)">{container.email}</div>
                        </div>
                      </label>
                    ))}
                    {allContainers.length === 0 && (
                      <p className="text-(--text-secondary) text-sm text-center py-4">
                        No containers available
                      </p>
                    )}
                  </div>
                )}
              </div>

              <div className="flex gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="btn btn-secondary flex-1"
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary flex-1">
                  Create User
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit User Modal */}
      {showEditModal && selectedUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-(--bg-secondary) rounded-lg shadow-xl max-w-lg w-full border border-(--bg-tertiary) p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-bold">Edit User</h3>
              <button
                onClick={() => {
                  setShowEditModal(false);
                  setSelectedUser(null);
                }}
                className="icon-btn"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleUpdateUser} className="space-y-4">
              {/* Username */}
              <div>
                <label className="block text-sm font-medium mb-1">Username</label>
                <input
                  type="text"
                  value={formData.username}
                  onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                  className="input w-full"
                  required
                  minLength={3}
                />
              </div>

              {/* Password */}
              <div>
                <label className="block text-sm font-medium mb-1">New Password (optional)</label>
                <input
                  type="password"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  className="input w-full"
                  placeholder="Leave blank to keep current password"
                  minLength={6}
                />
              </div>

              {formData.password && (
                <div>
                  <label className="block text-sm font-medium mb-1">Confirm New Password</label>
                  <input
                    type="password"
                    value={formData.confirmPassword}
                    onChange={(e) => setFormData({ ...formData, confirmPassword: e.target.value })}
                    className="input w-full"
                    placeholder="Confirm new password"
                  />
                </div>
              )}

              {/* Permissions */}
              <div className="space-y-2">
                <label className="block text-sm font-medium mb-2">Permissions</label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.is_admin}
                    onChange={(e) => setFormData({ ...formData, is_admin: e.target.checked })}
                  />
                  <span className="text-sm">Admin privileges</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.can_add_containers}
                    onChange={(e) => setFormData({ ...formData, can_add_containers: e.target.checked })}
                  />
                  <span className="text-sm">Can add containers</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.can_edit_server_accent}
                    onChange={(e) => setFormData({ ...formData, can_edit_server_accent: e.target.checked })}
                  />
                  <span className="text-sm">Can edit server accent color</span>
                </label>
              </div>

              {/* Container Access */}
              <div>
                <label className="block text-sm font-medium mb-2">Container Access</label>
                {formData.is_admin ? (
                  <p className="text-(--text-secondary) text-sm">
                    Admin users have access to all containers automatically.
                  </p>
                ) : (
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {allContainers.map((container) => (
                      <label
                        key={container.id}
                        className="flex items-center gap-3 p-3 rounded bg-(--bg-primary) cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={selectedContainerIds.includes(container.id)}
                          onChange={() => toggleContainer(container.id)}
                        />
                        <div className="flex-1">
                          <div className="font-medium text-sm">{container.container_name}</div>
                          <div className="text-xs text-(--text-secondary)">{container.email}</div>
                        </div>
                      </label>
                    ))}
                    {allContainers.length === 0 && (
                      <p className="text-(--text-secondary) text-sm text-center py-4">
                        No containers available
                      </p>
                    )}
                  </div>
                )}
              </div>

              <div className="flex gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => {
                    setShowEditModal(false);
                    setSelectedUser(null);
                  }}
                  className="btn btn-secondary flex-1"
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary flex-1">
                  Update User
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteModal && selectedUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="card max-w-md w-full">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-semibold">Delete User</h3>
              <button
                onClick={() => {
                  setShowDeleteModal(false);
                  setSelectedUser(null);
                }}
                className="icon-btn"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-(--text-secondary) mb-6">
              Are you sure you want to delete user{' '}
              <span className="text-white font-semibold">{selectedUser.username}</span>?
              This action cannot be undone.
            </p>

            <div className="flex gap-2 justify-end">
              <button
                onClick={() => {
                  setShowDeleteModal(false);
                  setSelectedUser(null);
                }}
                className="btn btn-secondary"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteUser}
                className="btn btn-error"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

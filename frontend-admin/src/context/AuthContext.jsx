import { createContext, useContext, useReducer, useEffect, useCallback } from 'react';
import api, { setOnUnauthorized } from '../api';

const AuthContext = createContext(null);

const initialState = {
  token: localStorage.getItem('auth_token'),
  user: JSON.parse(localStorage.getItem('auth_user') || 'null'),
  roles: JSON.parse(localStorage.getItem('auth_roles') || '[]'),
  current: JSON.parse(localStorage.getItem('auth_current') || 'null'),
  loading: true,
};

function reducer(state, action) {
  switch (action.type) {
    case 'LOGIN': {
      const { token, user, roles, current } = action.payload;
      localStorage.setItem('auth_token', token);
      localStorage.setItem('auth_user', JSON.stringify(user));
      localStorage.setItem('auth_roles', JSON.stringify(roles));
      localStorage.setItem('auth_current', JSON.stringify(current));
      return { ...state, token, user, roles, current, loading: false };
    }
    case 'LOGOUT':
      localStorage.removeItem('auth_token');
      localStorage.removeItem('auth_user');
      localStorage.removeItem('auth_roles');
      localStorage.removeItem('auth_current');
      return { token: null, user: null, roles: [], current: null, loading: false };
    case 'SWITCH_CONTEXT': {
      const { token, current } = action.payload;
      localStorage.setItem('auth_token', token);
      localStorage.setItem('auth_current', JSON.stringify(current));
      return { ...state, token, current };
    }
    case 'SET_LOADING':
      return { ...state, loading: action.payload };
    case 'REFRESH_ROLES': {
      localStorage.setItem('auth_roles', JSON.stringify(action.payload));
      return { ...state, roles: action.payload };
    }
    default:
      return state;
  }
}

export function AuthProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const logout = useCallback(() => {
    if (state.token) {
      api.logout(state.token).catch(() => {});
    }
    dispatch({ type: 'LOGOUT' });
  }, [state.token]);

  useEffect(() => {
    setOnUnauthorized(() => dispatch({ type: 'LOGOUT' }));
  }, []);

  useEffect(() => {
    if (!state.token) {
      dispatch({ type: 'SET_LOADING', payload: false });
      return;
    }
    api.getMe(state.token)
      .then((data) => {
        const current = {
          account_id: data.account_id,
          account_slug: data.account_slug,
          account_name: data.account_name,
          project_id: data.project_id,
          project_slug: data.project_slug,
          project_name: data.project_name,
          role: data.role,
        };
        const user = { id: data.user_id, name: data.user_name, email: data.email };
        const roles = data.available_roles || [];
        dispatch({
          type: 'LOGIN',
          payload: { token: state.token, user, roles, current },
        });
      })
      .catch(() => {
        dispatch({ type: 'LOGOUT' });
      });
  }, []);

  const login = async (email, password) => {
    const data = await api.login(email, password);
    dispatch({
      type: 'LOGIN',
      payload: {
        token: data.token,
        user: data.user,
        roles: data.roles,
        current: data.current,
      },
    });
  };

  const switchContext = async (accountId, projectId) => {
    const data = await api.switchContext(accountId, projectId, state.token);
    dispatch({
      type: 'SWITCH_CONTEXT',
      payload: {
        token: data.token,
        current: {
          account_id: data.account_id,
          account_slug: data.account_slug,
          account_name: data.account_name,
          project_id: data.project_id,
          project_slug: data.project_slug,
          project_name: data.project_name,
          role: data.role,
        },
      },
    });
  };

  const refreshRoles = async () => {
    const data = await api.getMe(state.token);
    dispatch({ type: 'REFRESH_ROLES', payload: data.available_roles || [] });
  };

  return (
    <AuthContext.Provider value={{ ...state, login, logout, switchContext, refreshRoles }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
